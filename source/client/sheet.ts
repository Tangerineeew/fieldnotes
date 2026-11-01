import { useEffect, useRef } from 'react';
import type React from 'react';
import { prefersReducedMotion } from './media';


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
    const reset = () => { element.style.transform = ''; element.style.transition = ''; element.style.animation = ''; };
    function down(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!element || event.button !== 0 || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
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
          dismiss.current(); window.setTimeout(reset, 400);
        } else window.setTimeout(() => { element.style.transition = ''; element.style.animation = ''; }, 300);
      };
      element.addEventListener('pointermove', move); element.addEventListener('pointerup', up);
      element.addEventListener('pointercancel', up);
    }
    element.addEventListener('pointerdown', down);
    return () => { element.removeEventListener('pointerdown', down); reset(); };
  }, [active, sheet.current]);
}
