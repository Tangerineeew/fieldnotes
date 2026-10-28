import { useEffect, useRef } from 'react';
import type React from 'react';


// Closes a popover on a press outside `root` or on Escape, while it is open. Escape also gives focus back to `trigger`, since
// the focused item inside the popover goes with it; a press outside leaves focus where the press put it.
export function useDismiss(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void,
  trigger?: React.RefObject<HTMLElement | null>) {
  const latest = useRef(close); latest.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) latest.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { latest.current(); trigger?.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
}

// Arrow keys, Home and End move through a menu's items; true when the key was one of them.
export function moveInMenu(event: React.KeyboardEvent, menu: HTMLElement) {
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
  const next = step ? buttons[(current + step + buttons.length) % buttons.length]
    : event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1) : undefined;
  if (!next) return false;
  event.preventDefault(); next.focus();
  return true;
}
