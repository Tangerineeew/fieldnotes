import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import { NoteIcon } from './note-icon';
import { isPhone, isRtl, prefersReducedMotion } from './media';
import { moveInMenu } from './popover';
import { useSheetDrag } from './sheet';
import { store, stored } from './storage';
import type { Translate } from './i18n';


export type FinderFolder = { id: string; parent_id: string | null; name: string; icon?: string | null; can_manage?: boolean };
export type FinderNote = { id: string; title: string; icon?: string | null; folder_id?: string | null; snippet?: string | null };
// A search result's passage with every searched word marked.
function Highlighted({ text, query, className }: { text: string; query: string; className?: string }) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = terms.length ? text.split(new RegExp(`(${terms.join('|')})`, 'gi')) : [text];
  return <span className={className}><bdi>{parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</bdi></span>;
}
// Drag and drop stays with the caller, which owns the moves it triggers.
export type FolderDecor<F> = {
  dropProps: (folder: F | null) => React.HTMLAttributes<HTMLElement>;
  dragClass: (key: string) => string;
  folderDrag: (folder: F) => React.HTMLAttributes<HTMLButtonElement> & { draggable?: boolean };
  noteDrag: (note: FinderNote) => React.HTMLAttributes<HTMLButtonElement> & { draggable?: boolean };
};
// Recently deleted, as Finder keeps its Trash: a row pinned to the foot of the first column, shown while it holds something, that
// opens its own column to the right as a folder would.
export type FinderBin = { label: string; open: boolean; onOpen: () => void; column: React.ReactNode };
// What a context menu was opened on: a folder, a note, or the empty space of the column listing `parent`.
export type FinderTarget<F, N> = { kind: 'folder'; folder: F } | { kind: 'note'; note: N } | { kind: 'blank'; parent: string | null };
// A menu opened by a held finger rises as a sheet from the bottom instead of sitting under the finger.
export type MenuPoint = { x: number; y: number; touch?: boolean };

const COLUMN_KEY = 'fieldnotes:column-width'; const COLUMN_MIN = 180; const COLUMN_MAX = 480;
// A folder or note shows under its parent only when the reader can see that parent; otherwise it sits at the top level,
// so a note shared from someone else's private folder is still reachable.
const parentOf = (parentId: string | null | undefined, visible: Set<string>) => parentId && visible.has(parentId) ? parentId : null;
export function finderIndex<F extends FinderFolder, N extends FinderNote>(folders: F[], notes: N[]) {
  const visible = new Set(folders.map((folder) => folder.id));
  const folderGroups = new Map<string | null, F[]>(); const noteGroups = new Map<string | null, N[]>();
  for (const folder of folders) {
    const key = parentOf(folder.parent_id, visible); folderGroups.set(key, [...(folderGroups.get(key) || []), folder]);
  }
  for (const note of notes) {
    const key = parentOf(note.folder_id, visible); noteGroups.set(key, [...(noteGroups.get(key) || []), note]);
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  // Root to `folderId`, following only parents the reader can see.
  const pathTo = (folderId: string | null) => {
    const path: string[] = [];
    for (let current = folderId; current && byId.has(current) && !path.includes(current);
      current = parentOf(byId.get(current)!.parent_id, visible))
      path.unshift(current);
    return path;
  };
  return { folders: (parent: string | null) => folderGroups.get(parent) || [],
    notes: (parent: string | null) => noteGroups.get(parent) || [],
    folder: (folderId: string) => byId.get(folderId), pathTo, parentOf: (note: N) => parentOf(note.folder_id, visible) };
}
export type FinderIndex<F extends FinderFolder, N extends FinderNote> = ReturnType<typeof finderIndex<F, N>>;

// A row's name, isolated for right-to-left text and shown whole on hover when the column cuts it short.
export const rowName = (name: string) => <span className="fn-finder-name" title={name}><bdi>{name}</bdi></span>;
const folderGlyph = (folder: FinderFolder) => folder.icon
  ? <span className="fn-finder-glyph" aria-hidden="true">{folder.icon}</span> : <Icon name="folder" />;
export const noteGlyph = ({ icon }: { icon?: string | null }, className?: string) => icon
  ? <NoteIcon icon={icon} className={className} /> : <Icon name="note" />;

// The menu key or Shift+F10 opens a row's menu just under it, where a right-click would open it at the pointer.
export function menuKeyPoint(event: React.KeyboardEvent, row: HTMLElement): MenuPoint | null {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return null;
  const box = row.getBoundingClientRect();
  return { x: isRtl() ? box.right - 24 : box.left + 24, y: box.bottom };
}


// Finder's column view: one column per folder on the path, each listing its subfolders then its notes, and a preview of the
// selected note at the end. Arrow keys move through it as in Finder; a second click or Enter on a selected note opens it.
export function FinderColumns<F extends FinderFolder, N extends FinderNote>({ index, path, previewId, results, query, preview, decor,
  empty, menuId, bin, rootLabel, selection, onSelection, onFolder, onPreview, onOpen, onMenu, t }: {
  index: FinderIndex<F, N>; path: string[]; previewId: string | null; results: N[] | null; query?: string; preview: React.ReactNode;
  rootLabel: string; selection: string[]; onSelection: (ids: string[]) => void;
  decor: FolderDecor<F>; empty: React.ReactNode; menuId: string | null; bin?: FinderBin | null; onFolder: (folderId: string | null) => void;
  onPreview: (note: N) => void; onOpen: (note: N) => void; onMenu: (target: FinderTarget<F, N>, at: MenuPoint) => void; t: Translate;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const binOpen = Boolean(bin?.open) && !results;
  // Columns share one width the reader can drag, as Finder's can; a double click puts it back, and it is kept per browser.
  const [columnWidth, setColumnWidth] = useState<number | null>(() => stored<number | null>(COLUMN_KEY, null));
  const keepWidth = (width: number | null) => { setColumnWidth(width); store(COLUMN_KEY, width); };
  const widthStyle = columnWidth ? { '--fn-column': `${columnWidth}px` } as React.CSSProperties : undefined;
  function resizer(position: number) {
    const columnOf = (handle: HTMLElement) => handle.previousElementSibling as HTMLElement;
    const clamp = (width: number) => Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, width)));
    return <div key={`resize-${position}`} className="fn-column-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t('Column width', '分栏宽度')} aria-valuemin={COLUMN_MIN} aria-valuemax={COLUMN_MAX}
      aria-valuenow={columnWidth ?? undefined} title={t('Drag to resize, double-click to reset', '拖动调整宽度，双击恢复')}
      onDoubleClick={() => keepWidth(null)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const grow = (event.key === 'ArrowRight') !== isRtl();
        keepWidth(clamp((columnWidth ?? columnOf(event.currentTarget).getBoundingClientRect().width) + (grow ? 16 : -16)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const handle = event.currentTarget; const start = event.clientX;
        const from = columnOf(handle).getBoundingClientRect().width; let width = from;
        handle.setPointerCapture(event.pointerId); handle.dataset.dragging = '';
        const move = (next: PointerEvent) => {
          width = clamp(from + (next.clientX - start) * (isRtl() ? -1 : 1));
          strip.current?.style.setProperty('--fn-column', `${width}px`);
        };
        const done = () => {
          handle.removeEventListener('pointermove', move); delete handle.dataset.dragging; keepWidth(width);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', done, { once: true }); handle.addEventListener('pointercancel', done, { once: true });
      }} />;
  }
  const columns: (string | null)[] = results || binOpen ? [null] : [null, ...path];
  // The last column sits at the inline end: the far right, or in RTL the far left, where scrollLeft runs negative.
  useEffect(() => {
    const element = strip.current;
    element?.scrollTo?.({ left: isRtl() ? -element.scrollWidth : element.scrollWidth,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [path.join('/'), previewId, Boolean(results), binOpen]);

  const pickNote = (note: N) => {
    // On a phone there is no room for a preview, so a tap opens the note.
    if (previewId === note.id || isPhone()) onOpen(note); else onPreview(note);
  };
  // Several rows of one column are selected as in Finder: Command or Control toggles a row, Shift extends from the last one
  // chosen, and Command-A takes the whole column. A plain click starts again from the one row.
  const anchor = useRef<string | null>(null);
  const rowIds = (column: Element) => Array.from(column.querySelectorAll<HTMLElement>('.fn-finder-row[data-id]'))
    .filter((row) => row.dataset.kind !== 'bin').map((row) => row.dataset.id!);
  const current = (column: Element) => {
    const ids = rowIds(column);
    return ids.filter((id) => selection.includes(id)).length ? selection.filter((id) => ids.includes(id))
      : ids.filter((id) => id === previewId || path.includes(id)).slice(-1);
  };
  function extend(event: React.MouseEvent | React.KeyboardEvent, id: string, toggle: boolean) {
    const column = (event.target as HTMLElement).closest('.fn-finder-column');
    if (!column) return;
    const ids = rowIds(column); const chosen = current(column);
    if (toggle) {
      onSelection(chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id]); anchor.current = id; return;
    }
    const from = ids.indexOf(anchor.current && ids.includes(anchor.current) ? anchor.current : chosen[0] ?? id);
    const to = ids.indexOf(id);
    onSelection(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
  }
  const multi = (event: React.MouseEvent, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) { event.preventDefault(); extend(event, id, !event.shiftKey); return true; }
    anchor.current = id; if (selection.length) onSelection([]);
    return false;
  };
  const targetOf = (row: HTMLElement, columnAt: number): FinderTarget<F, N> | null => {
    if (row.dataset.kind === 'folder') { const folder = index.folder(row.dataset.id!); return folder ? { kind: 'folder', folder } : null; }
    const note = (results || index.notes(columns[columnAt])).find((item) => item.id === row.dataset.id);
    return note ? { kind: 'note', note } : null;
  };
  // Right-click selects a note, as Finder does, and rings a folder without entering it; the empty part of a column offers
  // what can be made there.
  const targetAt = (element: HTMLElement): FinderTarget<F, N> | null => {
    if (element.closest('.fn-finder-preview')) return null;
    const column = element.closest<HTMLElement>('.fn-finder-column'); const row = element.closest<HTMLElement>('.fn-finder-row');
    // The bin's column and row keep their own menus.
    if (!column || (!row && results) || column.dataset.bin || row?.dataset.kind === 'bin') return null;
    const columnAt = Number(column.dataset.column);
    return row ? targetOf(row, columnAt) : { kind: 'blank', parent: columns[columnAt] };
  };
  const openMenu = (target: FinderTarget<F, N>, at: MenuPoint) => {
    if (target.kind === 'note' && previewId !== target.note.id && !at.touch) onPreview(target.note);
    onMenu(target, at);
  };
  // The sheet rises under the finger, so the tap that lifts it would land on a menu item; that one tap is swallowed wherever it
  // lands, however the menu was opened, and if none comes soon after the finger lifts, the next deliberate tap is left alone.
  const swallowRelease = () => {
    const swallow = (event: MouseEvent) => {
      event.preventDefault(); event.stopPropagation(); document.removeEventListener('click', swallow, true); press.current = null;
    };
    const expire = () => { document.removeEventListener('click', swallow, true); if (press.current?.fired) press.current = null; };
    const lifted = () => {
      document.removeEventListener('pointerup', lifted, true); document.removeEventListener('pointercancel', lifted, true);
      window.setTimeout(expire, 400);
    };
    document.addEventListener('click', swallow, true);
    document.addEventListener('pointerup', lifted, true); document.addEventListener('pointercancel', lifted, true);
  };
  // iOS never sends contextmenu for a long press, so a finger held still for half a second opens the menu itself. Android sends
  // both; whichever comes first opens it once.
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const endPress = () => { if (press.current && !press.current.fired) { window.clearTimeout(press.current.timer); press.current = null; } };
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'touch') return;
    endPress();
    const element = event.target as HTMLElement; const { clientX: x, clientY: y } = event;
    press.current = { x, y, fired: false, timer: window.setTimeout(() => {
      const target = targetAt(element);
      if (!target || !press.current) { press.current = null; return; }
      press.current.fired = true; openMenu(target, { x, y, touch: true }); swallowRelease();
    }, 500) };
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) endPress();
  }
  function onContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const touch = Boolean(press.current);
    if (press.current?.fired) { event.preventDefault(); return; }
    const target = targetAt(event.target as HTMLElement);
    if (!target) return;
    event.preventDefault();
    if (touch) { window.clearTimeout(press.current!.timer); press.current!.fired = true; }
    openMenu(target, { x: event.clientX, y: event.clientY, touch });
    if (touch) swallowRelease();
  }
  // Up and down select the neighbouring row, right enters a folder, left returns to the parent column, Enter opens, and the
  // menu key or Shift+F10 opens the row's menu.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.fn-finder-row');
    if (!row) return;
    const column = row.closest('.fn-finder-column')!; const rows = Array.from(column.querySelectorAll<HTMLButtonElement>('.fn-finder-row'));
    const at = rows.indexOf(row); const columnAt = Number(column.getAttribute('data-column'));
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); onSelection(rowIds(column)); return;
    }
    const point = menuKeyPoint(event, row);
    if (point) {
      const target = targetOf(row, columnAt);
      if (target) { event.preventDefault(); onMenu(target, point); }
      return;
    }
    const focusColumn = (position: number, pick: (buttons: HTMLButtonElement[]) => HTMLButtonElement | undefined) => {
      window.requestAnimationFrame(() => {
        const target = strip.current?.querySelector(`[data-column="${position}"]`);
        const button = target && pick(Array.from(target.querySelectorAll<HTMLButtonElement>('.fn-finder-row')));
        if (button) { button.focus(); button.click(); }
      });
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next && event.shiftKey && next.dataset.id) {
        event.preventDefault(); next.focus(); extend(event, next.dataset.id, false); return;
      }
      if (next) { event.preventDefault(); next.focus(); next.click(); }
    } else if (event.key === 'ArrowRight' && (row.dataset.kind === 'folder' || row.dataset.kind === 'bin')) {
      event.preventDefault(); focusColumn(columnAt + 1, (buttons) => buttons[0]);
    } else if (event.key === 'ArrowLeft' && columnAt > 0) {
      event.preventDefault(); focusColumn(columnAt - 1, (buttons) => buttons.find((button) => button.getAttribute('aria-current')));
    } else if (event.key === 'Enter' && row.dataset.kind === 'note') {
      event.preventDefault(); const target = targetOf(row, columnAt);
      if (target?.kind === 'note') onOpen(target.note);
    }
  }

  // A row's marks: ringed while its menu is open, filled while it is part of a selection.
  const marks = (id: string) => `${menuId === id ? ' is-context' : ''}${selection.includes(id) ? ' is-selected' : ''}`;
  // Without a mouse a held row opens its menu rather than starting a drag.
  const touchOnly = window.matchMedia?.('(hover: none)').matches;
  const drag = <T extends { draggable?: boolean }>(props: T) => touchOnly ? { ...props, draggable: false } : props;
  // A drag held near an edge scrolls the way it points: the strip sideways at its ends, a column at its top and bottom.
  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    const element = strip.current; if (!element) return;
    const box = element.getBoundingClientRect(); const edge = 40; const step = 12;
    if (event.clientX < box.left + edge) element.scrollBy({ left: -step });
    else if (event.clientX > box.right - edge) element.scrollBy({ left: step });
    const column = (event.target as HTMLElement).closest<HTMLElement>('.fn-finder-column');
    if (!column) return;
    const area = column.getBoundingClientRect();
    if (event.clientY < area.top + edge) column.scrollBy({ top: -step });
    else if (event.clientY > area.bottom - edge) column.scrollBy({ top: step });
  }
  return <div ref={strip} className="fn-finder" style={widthStyle} onKeyDown={onKeyDown} onDragOver={onDragOver}
    onContextMenu={onContextMenu} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPress}
    onPointerCancel={endPress}>
    {columns.map((parent, position) => {
      const folders = results ? [] : index.folders(parent); const notes = results || index.notes(parent);
      const selectedFolder = binOpen ? null : path[position] ?? null;
      const last = position === columns.length - 1 && !binOpen;
      return <div key={parent ?? 'root'} className={`fn-finder-column${last ? ' is-active' : ''}${decor.dragClass(parent ?? 'root')}`}
        data-column={position} role="group"
        aria-label={parent ? index.folder(parent)?.name : results ? t('Search results', '搜索结果') : rootLabel}
        {...(results ? {} : decor.dropProps(parent ? index.folder(parent)! : null))}>
        {folders.map((folder) => <div key={folder.id} className={`fn-finder-item${decor.dragClass(folder.id)}`}
          {...decor.dropProps(folder)}>
          <button type="button" className={`fn-finder-row${marks(folder.id)}`} data-kind="folder" data-id={folder.id}
            aria-current={selectedFolder === folder.id ? 'true' : undefined} {...drag(decor.folderDrag(folder))}
            onClick={(event) => { if (!multi(event, folder.id)) onFolder(folder.id); }}>
            {folderGlyph(folder)}{rowName(folder.name)}<Icon name="chevron-right" />
          </button>
        </div>)}
        {notes.map((note) => <button key={note.id} type="button" className={`fn-finder-row${marks(note.id)}${decor.dragClass(note.id)}`}
          data-kind="note" data-id={note.id} aria-current={previewId === note.id && last ? 'true' : undefined}
          {...drag(decor.noteDrag(note))}
          onClick={(event) => { if (!multi(event, note.id)) pickNote(note); }} onDoubleClick={() => onOpen(note)}>
          {noteGlyph(note)}{results && note.snippet
            ? <span className="fn-finder-result">{rowName(note.title)}
              <Highlighted className="fn-search-snippet" text={note.snippet} query={query || ''} /></span>
            : rowName(note.title)}
        </button>)}
        {!folders.length && !notes.length && <p className="fn-finder-empty">{position === 0 && !results ? empty
          : results ? t('No matching notes', '没有匹配的笔记') : t('This folder is empty', '此文件夹为空')}</p>}
        {position === 0 && bin && !results && <div className="fn-finder-bin">
          <button type="button" className="fn-finder-row" data-kind="bin" aria-current={bin.open ? 'true' : undefined}
            onClick={bin.onOpen}>
            <Icon name="trash" />{rowName(bin.label)}<Icon name="chevron-right" />
          </button>
        </div>}
      </div>;
    }).flatMap((column, position) => [column, resizer(position)])}
    {binOpen && bin!.column}
    <div className="fn-finder-preview">{preview}</div>
  </div>;
}


// One place of the small Finder: the way back up and the path to it, shared by the note browser and "Move to…".
function PlaceBar<F extends FinderFolder, N extends FinderNote>({ index, place, rootLabel, onPlace, t }: {
  index: FinderIndex<F, N>; place: string | null; rootLabel: string; onPlace: (folderId: string | null) => void; t: Translate;
}) {
  const path = index.pathTo(place);
  return <div className="fn-mini-finder-bar">
    <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" disabled={!place}
      aria-label={t('Back to Parent Folder', '返回上级文件夹')} title={t('Back to Parent Folder', '返回上级文件夹')}
      onClick={() => onPlace(path.length > 1 ? path[path.length - 2] : null)}><Icon name="chevron-left" /></button>
    <nav className="fn-mini-finder-path" aria-label={t('Location', '位置')}>
      {[null, ...path].map((folderId, position) => <React.Fragment key={folderId ?? 'root'}>
        {position > 0 && <Icon name="chevron-right" />}
        <button type="button" className="fn-finder-crumb" aria-current={folderId === place ? 'location' : undefined}
          onClick={() => onPlace(folderId)}><bdi>{folderId ? index.folder(folderId)?.name : rootLabel}</bdi></button>
      </React.Fragment>)}
    </nav>
  </div>;
}
const folderRow = (folder: FinderFolder, onEnter: () => void, disabled = false) => <div key={folder.id} role="listitem">
  <button type="button" className="fn-finder-row" data-kind="folder" disabled={disabled} onClick={onEnter}>
    {folderGlyph(folder)}{rowName(folder.name)}<Icon name="chevron-right" />
  </button>
</div>;


// A small Finder beside an open note: one place at a time, with the way back up above it. A folder opens in place and a note
// opens on the right. It starts where the open note lives, and goes there again whenever another note is opened.
export function FinderMini<F extends FinderFolder, N extends FinderNote>({ index, currentId, currentFolder, rootLabel, onOpen, t }: {
  index: FinderIndex<F, N>; currentId: string | null; currentFolder: string | null; rootLabel: string; onOpen: (note: N) => void;
  t: Translate;
}) {
  const [place, setPlace] = useState<string | null>(currentFolder);
  useEffect(() => { setPlace(currentFolder); }, [currentId]);
  const folders = index.folders(place); const notes = index.notes(place);
  return <div className="fn-mini-finder">
    <PlaceBar index={index} place={place} rootLabel={rootLabel} onPlace={setPlace} t={t} />
    <div className="fn-mini-finder-list" role="list">
      {folders.map((folder) => folderRow(folder, () => setPlace(folder.id)))}
      {notes.map((note) => <div key={note.id} role="listitem">
        <button type="button" className="fn-finder-row" data-kind="note" aria-current={note.id === currentId ? 'page' : undefined}
          onClick={() => onOpen(note)}>{noteGlyph(note)}{rowName(note.title)}</button>
      </div>)}
      {!folders.length && !notes.length && <p className="fn-finder-empty">{t('This folder is empty', '此文件夹为空')}</p>}
    </div>
  </div>;
}


// Where "Move to…" puts things: the small Finder's one place at a time, folders only, starting where the items live. A folder
// being moved is dimmed, since nothing goes inside itself; Move Here is off wherever the items can't go.
export function FolderPicker<F extends FinderFolder, N extends FinderNote>({ index, start, rootLabel, canEnter, canMoveHere, onMove,
  onCancel, t }: {
  index: FinderIndex<F, N>; start: string | null; rootLabel: string; canEnter: (folder: F) => boolean;
  canMoveHere: (folderId: string | null) => boolean; onMove: (folderId: string | null) => void; onCancel: () => void; t: Translate;
}) {
  const [place, setPlace] = useState<string | null>(start);
  const folders = index.folders(place);
  return <div className="fn-folder-picker">
    <PlaceBar index={index} place={place} rootLabel={rootLabel} onPlace={setPlace} t={t} />
    <div className="fn-mini-finder-list fn-folder-picker-list" role="list">
      {folders.map((folder) => folderRow(folder, () => setPlace(folder.id), !canEnter(folder)))}
      {!folders.length && <p className="fn-finder-empty">{t('No folders here', '这里没有文件夹')}</p>}
    </div>
    <div className="fn-confirm-actions">
      <button type="button" className="trek-btn trek-btn--secondary" onClick={onCancel}>{t('Cancel', '取消')}</button>
      <button type="button" className="trek-btn trek-btn--primary" disabled={!canMoveHere(place)} onClick={() => onMove(place)}>
        {t('Move Here', '移到这里')}</button>
    </div>
  </div>;
}

export type ContextMenuItem = { label: string; icon: IconName; onSelect: () => void; danger?: boolean; checked?: boolean } | 'separator';

// A context menu at the pointer, kept inside the window. It takes focus, moves with the arrow keys, and closes on Escape, a
// choice, or any press, scroll or blur outside it, giving focus back to where it came from.
export function ContextMenu({ at, label, items, onClose }: {
  at: MenuPoint; label: string; items: ContextMenuItem[]; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const restore = useRef(document.activeElement as HTMLElement | null);
  const done = useRef(onClose); done.current = onClose;
  // A sheet slides away before it goes; a menu at the pointer simply vanishes, as on the desktop.
  const [leaving, setLeaving] = useState(false);
  const close = useRef(() => {});
  close.current = () => {
    if (!at.touch) return done.current();
    if (leaving) return;
    setLeaving(true); window.setTimeout(() => done.current(), 200);
  };
  const [place, setPlace] = useState<{ left: number; top: number; origin: string } | null>(null);
  useLayoutEffect(() => {
    const element = menu.current!; const { width, height } = element.getBoundingClientRect();
    if (at.touch) { setPlace({ left: 0, top: 0, origin: 'bottom' }); return; }
    // The menu opens toward the inline end of the pointer (leftward in RTL) and flips only when that side lacks room.
    const rtl = isRtl(); const fits = rtl ? at.x - width >= 8 : at.x + width <= window.innerWidth - 8;
    const leftward = rtl === fits; const flipY = at.y + height > window.innerHeight - 8;
    setPlace({ left: leftward ? Math.max(8, at.x - width) : Math.min(at.x, window.innerWidth - width - 8),
      top: flipY ? Math.max(8, at.y - height) : at.y, origin: `${flipY ? 'bottom' : 'top'} ${leftward ? 'right' : 'left'}` });
    element.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
  }, [at.x, at.y]);
  useEffect(() => {
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    // Escape closes it even when focus never reached the menu, as after a right-click from outside the frame.
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close.current(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('scroll', outside, true);
    document.addEventListener('keydown', escape); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss);
      if (menu.current?.contains(document.activeElement)) restore.current?.focus({ preventScroll: true });
    };
  }, []);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!moveInMenu(event, menu.current!) && event.key === 'Tab') { event.preventDefault(); close.current(); }
  }
  const entries = items.map((item, position) => item === 'separator' ? <div key={position} className="fn-menu-separator" role="separator" />
    : <button key={position} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
      className={item.danger ? 'is-danger' : undefined}
      // A sheet finishes leaving before what it chose opens, so a confirmation never rises over a sheet still on screen.
      onClick={() => { close.current(); if (at.touch) window.setTimeout(item.onSelect, 200); else item.onSelect(); }}>
      <Icon name={item.icon} />{item.label}
    </button>);
  useSheetDrag(menu, Boolean(at.touch) && !leaving, () => close.current());
  // Portalled, so no transformed ancestor becomes the fixed position's frame. As a sheet it names what it acts on, over a scrim
  // whose press closes it like any press outside.
  // The scrim stays live while the sheet leaves, so the tap that dismissed it lands on the scrim, not on the page beneath.
  if (at.touch) return createPortal(<div className="fn-menu-sheet-scrim" data-leaving={leaving || undefined}>
    <div ref={menu} className="fn-context-menu fn-menu-sheet" role="menu" aria-label={label} onKeyDown={onKeyDown} inert={leaving}
      onContextMenu={(event) => event.preventDefault()}>
      <div className="fn-sheet-grabber" aria-hidden="true" /><p className="fn-menu-sheet-title">{label}</p>{entries}
    </div></div>, document.body);
  return createPortal(<div ref={menu} className="fn-folder-menu fn-context-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}
    onContextMenu={(event) => event.preventDefault()}
    style={place ? { left: place.left, top: place.top, transformOrigin: place.origin } : { left: at.x, top: at.y, visibility: 'hidden' }}>
    {entries}
  </div>, document.body);
}
