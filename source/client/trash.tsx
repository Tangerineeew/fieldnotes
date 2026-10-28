import { isPhone } from './media';
import { menuKeyPoint, noteGlyph, type MenuPoint } from './finder';
import type { Translate } from './i18n';


// A note deleted from a trip also says how the trip held it, and whether a live reference's original can still be shown.
export type DeletedNote = { id: string; title: string; icon?: string | null; deleted_at: string; purge_at: string;
  mode?: 'live' | 'snapshot'; unavailable?: boolean };

// The column Recently deleted opens beside the first: the library owner's deleted notes, or what a trip's editors removed, newest
// first. Finder's own keys move through it; a right-click or the menu key opens a note's menu, and on a phone, where there is no
// preview, a tap opens it as a sheet.
export function DeletedColumn({ notes, position, selectedId, menuId, onSelect, onMenu, t }: {
  notes: DeletedNote[]; position: number; selectedId: string | null; menuId: string | null;
  onSelect: (note: DeletedNote) => void; onMenu: (note: DeletedNote, at: MenuPoint) => void; t: Translate;
}) {
  return <div className="fn-finder-column is-active" data-column={position} data-bin="true" role="group"
    aria-label={t('Recently deleted', '最近删除')}>
    {notes.map((note) => <button key={note.id} type="button" data-kind="deleted" data-id={note.id}
      className={`fn-finder-row${menuId === note.id ? ' is-context' : ''}`} aria-current={selectedId === note.id ? 'true' : undefined}
      onClick={(event) => isPhone() ? onMenu(note, { x: event.clientX, y: event.clientY, touch: true }) : onSelect(note)}
      onContextMenu={(event) => {
        event.preventDefault(); if (!isPhone()) onSelect(note);
        onMenu(note, { x: event.clientX, y: event.clientY, touch: isPhone() });
      }}
      onKeyDown={(event) => {
        const point = menuKeyPoint(event, event.currentTarget);
        if (point) { event.preventDefault(); onMenu(note, point); }
      }}>
      {noteGlyph(note)}<span className="fn-finder-name">{note.title}</span>
    </button>)}
    {!notes.length && <p className="fn-finder-empty">{t('No deleted notes', '没有已删除的笔记')}</p>}
  </div>;
}
