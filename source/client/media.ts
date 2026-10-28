// The window queries the interface follows, in one place so every part switches at the same width.
const matches = (query: string) => Boolean(window.matchMedia?.(query).matches);

// One column, sheets instead of popovers, and no room for a preview.
export const isPhone = () => matches('(max-width: 700px)');
export const prefersReducedMotion = () => matches('(prefers-reduced-motion: reduce)');
