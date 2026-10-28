import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import { noteGlyph } from './finder';
import type { Heading } from './markdown';
import type { Translate } from './i18n';


export type PaletteNote = { id: string; title: string; icon?: string | null; path?: string };
export type PaletteCommand = { label: string; icon: IconName; run: () => void };
type Row = { key: string; label: string; detail?: string; icon: React.ReactNode; run: () => void };

// Obsidian's quick switcher and command palette in one window: typing finds a note, `>` turns it into the page's commands and
// `#` into the open note's headings. Arrow keys choose, Enter runs, Escape or a click outside closes.
export function Palette({ start, findNotes, commands, headings, onNote, onHeading, onClose, t }: {
  start: '' | '>'; findNotes: (query: string) => Promise<PaletteNote[]>; commands: PaletteCommand[]; headings: Heading[];
  onNote: (note: PaletteNote) => void; onHeading: (heading: string) => void; onClose: () => void; t: Translate;
}) {
  const [query, setQuery] = useState<string>(start);
  const [notes, setNotes] = useState<PaletteNote[]>([]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const mode = query.startsWith('>') ? 'commands' : query.startsWith('#') ? 'headings' : 'notes';
  const needle = (mode === 'notes' ? query : query.slice(1)).trim().toLocaleLowerCase();
  useEffect(() => {
    if (mode !== 'notes') return;
    let alive = true;
    const timer = window.setTimeout(() => void findNotes(needle).then((found) => alive && setNotes(found), () => {}), needle ? 120 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [mode, needle]);
  const close = (then?: () => void) => { onClose(); then?.(); };
  const rows: Row[] = mode === 'commands'
    ? commands.filter((command) => command.label.toLocaleLowerCase().includes(needle)).map((command) => ({
      key: command.label, label: command.label, icon: <Icon name={command.icon} />, run: () => close(command.run) }))
    : mode === 'headings'
      ? headings.filter((heading) => heading.text.toLocaleLowerCase().includes(needle)).map((heading, index) => ({
        key: `${index}`, label: heading.text, icon: <span className="fn-palette-glyph">#</span>,
        run: () => close(() => onHeading(heading.text)) }))
      : notes.map((note) => ({ key: note.id, label: note.title, detail: note.path,
        icon: noteGlyph(note, 'fn-note-icon--inline'),
        run: () => close(() => onNote(note)) }));
  useEffect(() => { setActive(0); }, [mode, needle, notes]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  const empty = mode === 'commands' ? t('No matching commands', '没有匹配的命令')
    : mode === 'headings' ? t('No matching headings', '没有匹配的小标题') : t('No matching notes', '没有匹配的笔记');
  return <div className="fn-palette-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="fn-palette" role="dialog" aria-modal="true" aria-label={t('Quick open', '快速打开')}>
      <div className="fn-palette-field">
        <Icon name="search" />
        <input autoFocus className="fn-palette-input" value={query} role="combobox" aria-expanded="true" aria-controls="fn-palette-list"
          aria-activedescendant={rows[active] ? `fn-palette-${active}` : undefined} spellCheck={false}
          placeholder={t('Go to a note, > for commands, # for headings', '前往笔记，输入 > 执行命令，# 跳到小标题')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (rows.length) setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); rows[active]?.run(); }
          }} />
      </div>
      <div ref={list} id="fn-palette-list" className="fn-palette-list" role="listbox">
        {rows.map((row, index) => <div key={row.key} id={`fn-palette-${index}`} role="option" aria-selected={index === active}
          className="fn-palette-row" onPointerMove={() => setActive(index)} onClick={row.run}>
          <span className="fn-palette-icon">{row.icon}</span>
          <span className="fn-palette-label">{row.label}</span>
          {row.detail && <span className="fn-palette-detail">{row.detail}</span>}
        </div>)}
        {!rows.length && <p className="fn-palette-empty">{empty}</p>}
      </div>
      <p className="fn-palette-footer">{t('↑↓ to choose · ↵ to open · esc to close', '↑↓ 选择 · ↵ 打开 · esc 关闭')}</p>
    </div>
  </div>;
}
