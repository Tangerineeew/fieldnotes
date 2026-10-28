import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { useDismiss } from './popover';
import type { Heading } from './markdown';
import type { Translate } from './i18n';


// The headings of the note being read, in a popover under its own button; choosing one scrolls there and marks it, as a heading
// link does. Shown once a note has two headings or more. Docked, the button only opens and closes `OutlinePanel` beside the note.
export function Outline({ headings, onJump, docked, t }: {
  headings: Heading[]; onJump: (heading: string) => void; docked?: { open: boolean; onToggle: (open: boolean) => void }; t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, root, () => setOpen(false), trigger);
  useEffect(() => { if (open) root.current?.querySelector<HTMLButtonElement>('.fn-outline-item')?.focus(); }, [open]);
  useEffect(() => { if (docked) setOpen(false); }, [Boolean(docked)]);
  if (headings.length < 2) return null;
  return <div ref={root} className="fn-outline">
    {docked ? <button type="button" className="trek-btn trek-btn--secondary fn-icon-button fn-outline-toggle" aria-pressed={docked.open}
      aria-label={t('Outline', '大纲')} title={t('Outline', '大纲')} onClick={() => docked.onToggle(!docked.open)}>
      <Icon name="outline" /></button>
      : <button ref={trigger} type="button" className="trek-btn trek-btn--secondary fn-icon-button" aria-expanded={open}
        aria-label={t('Outline', '大纲')} title={t('Outline', '大纲')} onClick={() => setOpen(!open)}><Icon name="outline" /></button>}
    {open && !docked && <nav className="fn-outline-popover" aria-label={t('Outline', '大纲')}>
      <OutlineItems headings={headings} onJump={(heading) => { setOpen(false); onJump(heading); }} />
    </nav>}
  </div>;
}

function OutlineItems({ headings, onJump }: { headings: Heading[]; onJump: (heading: string) => void }) {
  const top = Math.min(...headings.map((heading) => heading.level));
  return <>{headings.map((heading, index) => <button key={index} type="button" className="fn-outline-item"
    style={{ paddingInlineStart: 10 + Math.min(heading.level - top, 3) * 14 }}
    data-level={heading.level - top} onClick={() => onJump(heading.text)}>{heading.text}</button>)}</>;
}

// The outline docked beside a trip note, above its comments: it stays open while the reader moves through the note. It stays mounted
// so it can fold away, and `inert` keeps it out of reach closed.
export function OutlinePanel({ headings, open, onJump, onClose, t }: {
  headings: Heading[]; open: boolean; onJump: (heading: string) => void; onClose: () => void; t: Translate;
}) {
  const shown = open && headings.length >= 2;
  return <div className="fn-outline-dock" data-open={shown || undefined} inert={!shown}>
    <div><nav className="fn-outline-panel" aria-labelledby="outline-heading">
      <div className="fn-comment-panel-header">
        <h3 id="outline-heading">{t('Outline', '大纲')}</h3>
        <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" aria-label={t('Close', '关闭')} title={t('Close', '关闭')}
          onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="fn-outline-panel-items">{headings.length >= 2 && <OutlineItems headings={headings} onJump={onJump} />}</div>
    </nav></div>
  </div>;
}
