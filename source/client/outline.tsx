import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { isPhone } from './media';
import { useDismiss } from './popover';
import { useSheetDrag } from './sheet';
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
  const layer = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  useDismiss(open, root, () => setOpen(false), trigger, layer);
  useSheetDrag(sheet, open && !docked && isPhone(), () => setOpen(false));
  useEffect(() => { if (open) (layer.current ?? root.current)?.querySelector<HTMLButtonElement>('.fn-outline-item')?.focus(); }, [open]);
  useEffect(() => { if (docked) setOpen(false); }, [Boolean(docked)]);
  if (headings.length < 2) return null;
  const items = <OutlineItems headings={headings} onJump={(heading) => { setOpen(false); onJump(heading); }} />;
  return <div ref={root} className="fn-outline">
    {docked ? <button type="button" className="trek-btn trek-btn--secondary fn-icon-button fn-outline-toggle" aria-pressed={docked.open}
      aria-label={t('Outline', '大纲')} title={t('Outline', '大纲')} onClick={() => docked.onToggle(!docked.open)}>
      <Icon name="outline" /></button>
      : <button ref={trigger} type="button" className="trek-btn trek-btn--secondary fn-icon-button" aria-expanded={open}
        aria-label={t('Outline', '大纲')} title={t('Outline', '大纲')} onClick={() => setOpen(!open)}><Icon name="outline" /></button>}
    {open && !docked && !isPhone() && <nav className="fn-outline-popover" aria-label={t('Outline', '大纲')}>{items}</nav>}
    {/* On a phone the outline is a sheet over the whole screen, so it leaves the note card, whose container query would hold it.
        The dimmed page behind it takes the press that closes it, so the press goes no further. Only the headings scroll. */}
    {open && !docked && isPhone() && createPortal(<div ref={layer} className="fn-outline-layer">
      <div className="fn-outline-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <nav ref={sheet} className="fn-outline-sheet" aria-label={t('Outline', '大纲')}>
        <div className="fn-sheet-grabber" aria-hidden="true" />
        <p className="fn-menu-sheet-title fn-outline-sheet-title">{t('Outline', '大纲')}</p>
        <div className="fn-outline-sheet-items">{items}</div>
      </nav>
    </div>, document.body)}
  </div>;
}

function OutlineItems({ headings, onJump }: { headings: Heading[]; onJump: (heading: string) => void }) {
  const top = Math.min(...headings.map((heading) => heading.level));
  return <>{headings.map((heading, index) => <button key={index} type="button" className="fn-outline-item"
    style={{ paddingInlineStart: 10 + Math.min(heading.level - top, 3) * 14 }}
    data-level={heading.level - top} onClick={() => onJump(heading.text)}><bdi>{heading.text}</bdi></button>)}</>;
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
