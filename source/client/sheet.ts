import { useEffect, useRef } from 'react';
import type React from 'react';
import { isNarrow, isRtl, prefersReducedMotion } from './media';


// The layers that sit over the page; the edge swipe leaves them alone.
const OVERLAYS = '.fn-modal-backdrop, .fn-menu-sheet-scrim, .fn-context-menu, .fn-sort-menu, .fn-new-folder-popover, .fn-palette-backdrop, '
  + '.fn-pdf-all, .fn-outline-popover, .fn-outline-sheet, .fn-trek-pop';
// The note browser and comments are sheets only on a narrow screen; beside the note they leave the swipe alone.
const SHEETS = ':is(.fn-note-browser, .fn-comment-panel)[data-open]';
const overlayUp = () => document.querySelector(isNarrow() ? `${OVERLAYS}, ${SHEETS}` : OVERLAYS);

// Where a released flick comes to rest, as Apple projects it (Designing Fluid Interfaces): exponential deceleration, not v²/2a.
const project = (velocity: number, rate = 0.998) => (velocity / 1000) * rate / (1 - rate);
// Past its top a sheet resists more the further it is pulled, so an edge reads as "nothing more here" rather than frozen.
const rubberBand = (overshoot: number, size: number, constant = 0.55) => (overshoot * size * constant) / (size + constant * overshoot);
// A sheet is taken by its grabber, its header or its top strip; controls there keep their own presses.
const HANDLES = '.fn-sheet-grabber, .fn-modal-header, .fn-menu-sheet-title, .fn-comment-panel-header';
const TOP_STRIP = 28;

// A bottom sheet follows a downward drag 1:1 and goes when it is thrown or pulled past a third of its height; otherwise it springs
// back. Released, it carries on at the finger's speed, so nothing jumps between the drag and the motion that finishes it.
export function useSheetDrag(sheet: React.RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    const element = sheet.current;
    if (!active || !element) return;
    return sheetDrag(element, () => dismiss.current());
  }, [active, sheet.current]);
}

// The same for a sheet built outside React; returns what detaches it.
export function sheetDrag(element: HTMLElement, dismiss: () => void) {
  const reset = () => { element.style.transform = ''; element.style.transition = ''; element.style.animation = ''; };
  function down(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    if (!target.closest(HANDLES) && event.clientY - element.getBoundingClientRect().top > TOP_STRIP) return;
    const start = event.clientY; const samples = [{ y: 0, t: event.timeStamp }];
    let offset = 0; let dragging = false;
    const move = (next: PointerEvent) => {
      const delta = next.clientY - start;
      // A few pixels of give first, so a tap on the header is still a tap.
      if (!dragging && Math.abs(delta) < 6) return;
      if (!dragging) {
        dragging = true; element.setPointerCapture(event.pointerId);
        element.style.transition = 'none'; element.style.animation = 'none';
      }
      offset = delta >= 0 ? delta : -rubberBand(-delta, element.offsetHeight);
      element.style.transform = `translateY(${offset}px)`;
      samples.push({ y: offset, t: next.timeStamp }); if (samples.length > 5) samples.shift();
    };
    const up = () => {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (!dragging) return;
      const first = samples[0]; const last = samples[samples.length - 1];
      const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) * 1000 : 0;
      const away = offset + project(velocity) > element.offsetHeight / 3 && velocity > -200;
      const still = prefersReducedMotion();
      element.style.transition = still ? 'none' : away ? 'transform 200ms cubic-bezier(.3, 0, .8, .15)'
        : 'transform 300ms var(--trek-ease-quint)';
      element.style.transform = away ? 'translateY(100%)' : '';
      if (away) {
        // The sheet is already gone, so its own leaving animation must not run again from the top.
        dismiss(); window.setTimeout(reset, 400);
      } else window.setTimeout(() => { element.style.transition = ''; element.style.animation = ''; }, 300);
    };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  }
  element.addEventListener('pointerdown', down);
  return () => { element.removeEventListener('pointerdown', down); reset(); };
}

// TREK's swipe from the screen's leading edge stops at the frame, so the page answers it itself, as every iOS screen does: the page
// follows the finger and goes back once released past a third of the width or thrown; otherwise it springs back. `back` is null
// where there is nowhere to go back to, and the swipe is left alone while a sheet or window is up.
const EDGE = 22;
const CLAIM = 10;
export function useEdgeBack(page: React.RefObject<HTMLElement | null>, back: (() => void) | null) {
  const latest = useRef(back); latest.current = back;
  useEffect(() => {
    let start: { x: number; y: number } | null = null; let claimed = false; let samples: { x: number; t: number }[] = [];
    // How far the finger has travelled away from the edge it started at.
    const travel = (x: number) => (start ? (isRtl() ? start.x - x : x - start.x) : 0);
    const slide = (offset: number, transition = 'none') => {
      const element = page.current; if (!element) return;
      element.style.transition = transition;
      element.style.transform = offset ? `translateX(${isRtl() ? -offset : offset}px)` : '';
      element.style.boxShadow = offset ? '-16px 0 40px -12px rgb(0 0 0 / .35)' : '';
    };
    function begin(event: TouchEvent) {
      start = null; claimed = false;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !latest.current || overlayUp()) return;
      if ((isRtl() ? window.innerWidth - touch.clientX : touch.clientX) > EDGE) return;
      start = { x: touch.clientX, y: touch.clientY }; samples = [{ x: 0, t: event.timeStamp }];
    }
    function follow(event: TouchEvent) {
      if (!start) return;
      const touch = event.touches[0]; const offset = travel(touch.clientX); const vertical = Math.abs(touch.clientY - start.y);
      if (!claimed) {
        if (offset < CLAIM && vertical < CLAIM) return;
        // Sideways has to clearly beat vertical, so scrolling near the edge stays scrolling.
        if (offset < CLAIM || offset < vertical * 1.5) { start = null; return; }
        claimed = true;
      }
      event.preventDefault();
      samples.push({ x: offset, t: event.timeStamp }); if (samples.length > 5) samples.shift();
      slide(Math.max(0, offset));
    }
    // A cancelled touch (the system took the gesture) springs back rather than going back.
    function end(event: TouchEvent) {
      if (!start || !claimed) { start = null; return; }
      const first = samples[0]; const last = samples[samples.length - 1]; start = null; claimed = false;
      const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) * 1000 : 0;
      const width = window.innerWidth; const still = prefersReducedMotion();
      if (event.type === 'touchend' && last.x + project(velocity) > width / 3 && velocity > -200) {
        slide(width, still ? 'none' : 'transform 200ms cubic-bezier(.3, 0, .8, .15)');
        // The view behind replaces this one before the page comes back into place, so nothing flashes between them.
        window.setTimeout(() => { latest.current?.(); window.setTimeout(() => slide(0), 60); }, still ? 0 : 200);
      } else slide(0, still ? 'none' : 'transform 300ms var(--trek-ease-quint)');
    }
    document.addEventListener('touchstart', begin, { passive: true });
    document.addEventListener('touchmove', follow, { passive: false });
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
    return () => {
      document.removeEventListener('touchstart', begin); document.removeEventListener('touchmove', follow);
      document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
    };
  }, []);
}
