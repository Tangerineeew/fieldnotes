// The window queries the interface follows, in one place so every part switches at the same width.
const matches = (query: string) => Boolean(window.matchMedia?.(query).matches);

// One column, sheets instead of popovers, and no room for a preview.
export const isPhone = () => matches('(max-width: 700px)');
export const prefersReducedMotion = () => matches('(prefers-reduced-motion: reduce)');
// Below 860px the note browser and comments are sheets over the note.
export const NARROW = '(max-width: 860px)';
export const isNarrow = () => matches(NARROW);
// TREK's kit sets the frame's direction on <html> from the host's language.
export const isRtl = (doc: Document = document) => doc.documentElement.dir === 'rtl';

// Where a floating layer `width` wide starts so it hangs from the anchor's start edge (its right one in RTL), 8px inside the window;
// `side` is the edge it grows from, for its transform origin.
export function hangFrom(anchor: { left: number; right: number }, width: number, win: Window = window) {
  const rtl = isRtl(win.document);
  const left = Math.max(8, Math.min(rtl ? anchor.right - width : anchor.left, win.innerWidth - width - 8));
  return { left, side: rtl ? 'right' : 'left' };
}
