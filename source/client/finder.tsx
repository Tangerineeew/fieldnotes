import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import { NoteIcon } from './note-icon';
import { isPhone, prefersReducedMotion } from './media';
import { moveInMenu } from './popover';
import type { Translate } from './i18n';


export type FinderFolder = { id: string; parent_id: string | null; name: string; icon?: string | null; can_manage?: boolean };
export type FinderNote = { id: string; title: string; icon?: string | null; folder_id?: string | null; snippet?: string | null };
// A search result's passage with every searched word marked.
function Highlighted({ text, query, className }: { text: string; query: string; className?: string }) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = terms.length ? text.split(new RegExp(`(${terms.join('|')})`, 'gi')) : [text];
  return <span className={className}>{parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</span>;
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

const folderGlyph = (folder: FinderFolder) => folder.icon
  ? <span className="fn-finder-glyph" aria-hidden="true">{folder.icon}</span> : <Icon name="folder" />;
export const noteGlyph = ({ icon }: { icon?: string | null }, className?: string) => icon
  ? <NoteIcon icon={icon} className={className} /> : <Icon name="note" />;

// The menu key or Shift+F10 opens a row's menu just under it, where a right-click would open it at the pointer.
export function menuKeyPoint(event: React.KeyboardEvent, row: HTMLElement): MenuPoint | null {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return null;
  const box = row.getBoundingClientRect();
  return { x: box.left + 24, y: box.bottom };
}


// Finder's column view: one column per folder on the path, each listing its subfolders then its notes, and a preview of the
// selected note at the end. Arrow keys move through it as in Finder; a second click or Enter on a selected note opens it.
export function FinderColumns<F extends FinderFolder, N extends FinderNote>({ index, path, previewId, results, query, preview, decor,
  empty, menuId, bin, rootLabel, onFolder, onPreview, onOpen, onMenu, t }: {
  index: FinderIndex<F, N>; path: string[]; previewId: string | null; results: N[] | null; query?: string; preview: React.ReactNode;
  rootLabel: string;
  decor: FolderDecor<F>; empty: React.ReactNode; menuId: string | null; bin?: FinderBin | null; onFolder: (folderId: string | null) => void;
  onPreview: (note: N) => void; onOpen: (note: N) => void; onMenu: (target: FinderTarget<F, N>, at: MenuPoint) => void; t: Translate;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const binOpen = Boolean(bin?.open) && !results;
  const columns: (string | null)[] = results || binOpen ? [null] : [null, ...path];
  useEffect(() => {
    const element = strip.current;
    element?.scrollTo?.({ left: element.scrollWidth, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [path.join('/'), previewId, Boolean(results), binOpen]);

  const pickNote = (note: N) => {
    // On a phone there is no room for a preview, so a tap opens the note.
    if (previewId === note.id || isPhone()) onOpen(note); else onPreview(note);
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
  // iOS never sends contextmenu for a long press, so a finger held still for half a second opens the menu itself, and the
  // tap that ends the press is swallowed. Android sends both; whichever comes first opens it once.
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const endPress = () => { if (press.current && !press.current.fired) { window.clearTimeout(press.current.timer); press.current = null; } };
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'touch') return;
    endPress();
    const element = event.target as HTMLElement; const { clientX: x, clientY: y } = event;
    press.current = { x, y, fired: false, timer: window.setTimeout(() => {
      const target = targetAt(element);
      if (!target || !press.current) { press.current = null; return; }
      press.current.fired = true; openMenu(target, { x, y, touch: true });
    }, 500) };
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) endPress();
  }
  function onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (!press.current?.fired) return;
    press.current = null; event.preventDefault(); event.stopPropagation();
  }
  function onContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const touch = Boolean(press.current);
    if (press.current?.fired) { event.preventDefault(); return; }
    const target = targetAt(event.target as HTMLElement);
    if (!target) return;
    event.preventDefault();
    if (touch) { window.clearTimeout(press.current!.timer); press.current!.fired = true; }
    openMenu(target, { x: event.clientX, y: event.clientY, touch });
  }
  // Up and down select the neighbouring row, right enters a folder, left returns to the parent column, Enter opens, and the
  // menu key or Shift+F10 opens the row's menu.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.fn-finder-row');
    if (!row) return;
    const column = row.closest('.fn-finder-column')!; const rows = Array.from(column.querySelectorAll<HTMLButtonElement>('.fn-finder-row'));
    const at = rows.indexOf(row); const columnAt = Number(column.getAttribute('data-column'));
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

  const ring = (id: string) => menuId === id ? ' is-context' : '';
  // Without a mouse a held row opens its menu rather than starting a drag.
  const touchOnly = window.matchMedia?.('(hover: none)').matches;
  const drag = <T extends { draggable?: boolean }>(props: T) => touchOnly ? { ...props, draggable: false } : props;
  return <div ref={strip} className="fn-finder" onKeyDown={onKeyDown} onContextMenu={onContextMenu} onPointerDown={onPointerDown}
    onPointerMove={onPointerMove} onPointerUp={endPress} onPointerCancel={endPress} onClickCapture={onClickCapture}>
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
          <button type="button" className={`fn-finder-row${ring(folder.id)}`} data-kind="folder" data-id={folder.id}
            aria-current={selectedFolder === folder.id ? 'true' : undefined} {...drag(decor.folderDrag(folder))}
            onClick={() => onFolder(folder.id)}>
            {folderGlyph(folder)}<span className="fn-finder-name">{folder.name}</span><Icon name="chevron-right" />
          </button>
        </div>)}
        {notes.map((note) => <button key={note.id} type="button" className={`fn-finder-row${ring(note.id)}${decor.dragClass(note.id)}`}
          data-kind="note" data-id={note.id} aria-current={previewId === note.id && last ? 'true' : undefined}
          {...drag(decor.noteDrag(note))}
          onClick={() => pickNote(note)} onDoubleClick={() => onOpen(note)}>
          {noteGlyph(note)}{results && note.snippet
            ? <span className="fn-finder-result"><span className="fn-finder-name">{note.title}</span>
              <Highlighted className="fn-search-snippet" text={note.snippet} query={query || ''} /></span>
            : <span className="fn-finder-name">{note.title}</span>}
        </button>)}
        {!folders.length && !notes.length && <p className="fn-finder-empty">{position === 0 && !results ? empty
          : results ? t('No matching notes', '没有匹配的笔记') : t('This folder is empty', '此文件夹为空')}</p>}
        {position === 0 && bin && !results && <div className="fn-finder-bin">
          <button type="button" className="fn-finder-row" data-kind="bin" aria-current={bin.open ? 'true' : undefined}
            onClick={bin.onOpen}>
            <Icon name="trash" /><span className="fn-finder-name">{bin.label}</span><Icon name="chevron-right" />
          </button>
        </div>}
      </div>;
    })}
    {binOpen && bin!.column}
    <div className="fn-finder-preview">{preview}</div>
  </div>;
}


// A small Finder beside an open note: one place at a time, with the way back up above it. A folder opens in place and a note
// opens on the right. It starts where the open note lives, and goes there again whenever another note is opened.
export function FinderMini<F extends FinderFolder, N extends FinderNote>({ index, currentId, currentFolder, rootLabel, onOpen, t }: {
  index: FinderIndex<F, N>; currentId: string | null; currentFolder: string | null; rootLabel: string; onOpen: (note: N) => void;
  t: Translate;
}) {
  const [place, setPlace] = useState<string | null>(currentFolder);
  useEffect(() => { setPlace(currentFolder); }, [currentId]);
  const path = index.pathTo(place);
  const folders = index.folders(place); const notes = index.notes(place);
  return <div className="fn-mini-finder">
    <div className="fn-mini-finder-bar">
      <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" disabled={!place}
        aria-label={t('Back to parent folder', '返回上级文件夹')} title={t('Back to parent folder', '返回上级文件夹')}
        onClick={() => setPlace(path.length > 1 ? path[path.length - 2] : null)}><Icon name="chevron-left" /></button>
      <nav className="fn-mini-finder-path" aria-label={t('Location', '位置')}>
        {[null, ...path].map((folderId, position) => <React.Fragment key={folderId ?? 'root'}>
          {position > 0 && <Icon name="chevron-right" />}
          <button type="button" className="fn-finder-crumb" aria-current={folderId === place ? 'location' : undefined}
            onClick={() => setPlace(folderId)}>{folderId ? index.folder(folderId)?.name : rootLabel}</button>
        </React.Fragment>)}
      </nav>
    </div>
    <div className="fn-mini-finder-list" role="list">
      {folders.map((folder) => <div key={folder.id} role="listitem">
        <button type="button" className="fn-finder-row" data-kind="folder" onClick={() => setPlace(folder.id)}>
          {folderGlyph(folder)}<span className="fn-finder-name">{folder.name}</span><Icon name="chevron-right" />
        </button>
      </div>)}
      {notes.map((note) => <div key={note.id} role="listitem">
        <button type="button" className="fn-finder-row" data-kind="note" aria-current={note.id === currentId ? 'page' : undefined}
          onClick={() => onOpen(note)}>
          {noteGlyph(note)}<span className="fn-finder-name">{note.title}</span>
        </button>
      </div>)}
      {!folders.length && !notes.length && <p className="fn-finder-empty">{t('This folder is empty', '此文件夹为空')}</p>}
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
    const flipX = at.x + width > window.innerWidth - 8; const flipY = at.y + height > window.innerHeight - 8;
    setPlace({ left: flipX ? Math.max(8, at.x - width) : at.x, top: flipY ? Math.max(8, at.y - height) : at.y,
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}` });
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
      className={item.danger ? 'is-danger' : undefined} onClick={() => { close.current(); item.onSelect(); }}>
      <Icon name={item.icon} />{item.label}
    </button>);
  // Portalled, so no transformed ancestor becomes the fixed position's frame. As a sheet it names what it acts on, over a scrim
  // whose press closes it like any press outside.
  // The scrim stays live while the sheet leaves, so the tap that dismissed it lands on the scrim, not on the page beneath.
  if (at.touch) return createPortal(<div className="fn-menu-sheet-scrim" data-leaving={leaving || undefined}>
    <div ref={menu} className="fn-context-menu fn-menu-sheet" role="menu" aria-label={label} onKeyDown={onKeyDown} inert={leaving}
      onContextMenu={(event) => event.preventDefault()}>
      <p className="fn-menu-sheet-title">{label}</p>{entries}
    </div></div>, document.body);
  return createPortal(<div ref={menu} className="fn-folder-menu fn-context-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}
    onContextMenu={(event) => event.preventDefault()}
    style={place ? { left: place.left, top: place.top, transformOrigin: place.origin } : { left: at.x, top: at.y, visibility: 'hidden' }}>
    {entries}
  </div>, document.body);
}
