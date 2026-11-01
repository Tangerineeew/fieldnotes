// Conveniences kept per browser: losing them (a private window, cleared data, a sandbox without storage) only loses the
// convenience, so every read falls back and every write may fail quietly.
export function stored<T>(key: string, fallback: T): T {
  try { const value = window.localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) as T; }
  catch { return fallback; }
}
export function store(key: string, value: unknown) {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* the page works the same without it */ }
}
