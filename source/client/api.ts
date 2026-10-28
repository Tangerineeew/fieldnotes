import { translate, type Vars } from './i18n';
import { bodyLimitBytes, bodyPartChars } from '../shared/limits.json';


export type Invoke = <T>(path: string, options?: { method: string; body: unknown }) => Promise<T>;
type Envelope = { error: string; status: number; template?: string; params?: Vars };

// `code` is the HTTP status (the collab session tells fatal from retryable by it); `template` is the English
// message, so callers can recognise a failure without depending on the translated text.
export class RequestError extends Error {
  constructor(message: string, readonly code: number, readonly template: string) { super(message); }
}

// TREK caps how often a plugin may call it, so a request refused while Fieldnotes (503) or the host (429) is busy succeeds once
// that budget refills: it is asked again after a growing pause.
export async function whenIdle<T>(request: () => Promise<T>, pauses = [1000, 2000, 4000]): Promise<T> {
  for (const pause of pauses) {
    try { return await request(); }
    catch (error) {
      if (!(error instanceof RequestError) || (error.code !== 503 && error.code !== 429)) throw error;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return request();
}

// Base64 for bytes of any size: `String.fromCharCode` takes them in slices, since spreading a large array overflows the stack.
export function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
export const decodeBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const isEnvelope = (value: unknown): value is Envelope => typeof value === 'object' && value !== null
  && typeof (value as Envelope).error === 'string' && typeof (value as Envelope).status === 'number';

// TREK parses request bodies up to 100 KB, so a larger one goes ahead in parts: slices of its UTF-8 bytes in base64, then
// `{ parts_id }` in its place. A trip page sends everything through the companion's /trip route, and so its parts.
export function withParts(invoke: Invoke): Invoke {
  return async <T,>(path: string, options?: { method: string; body: unknown }) => {
    const bytes = options?.method === 'POST' ? new TextEncoder().encode(JSON.stringify(options.body)) : null;
    if (!bytes || bytes.length <= bodyLimitBytes) return invoke<T>(path, options);
    const encoded = encodeBase64(bytes); const id = crypto.randomUUID(); const parts = Math.ceil(encoded.length / bodyPartChars);
    for (let part = 0; part < parts; part += 1) {
      const slice = { id, part, parts, data: encoded.slice(part * bodyPartChars, (part + 1) * bodyPartChars) };
      const stored = await invoke<unknown>(path === '/trip' ? '/trip' : '/part', { method: 'POST',
        body: path === '/trip' ? { action: 'part', ...slice } : slice });
      if (isEnvelope(stored)) return stored as T;
    }
    return invoke<T>(path, { method: 'POST', body: { parts_id: id } });
  };
}

// TREK's frame bridge turns a failed route into "Request failed with status code N" and drops its body, so the
// server sends expected failures as a 200 envelope; this raises them again, translated, with their status.
export function withErrors(invoke: Invoke, locale: () => string | undefined): Invoke {
  return async <T,>(path: string, options?: { method: string; body: unknown }) => {
    let result: unknown;
    try { result = await invoke<unknown>(path, options); }
    catch (error) {
      const code = Number((error as { code?: unknown }).code) || 0;
      const template = code === 429 ? 'Too many requests. Wait a moment and try again.'
        : 'Request failed. Try again or check the plugin logs.';
      throw new RequestError(translate(template, locale()), code, template);
    }
    if (!isEnvelope(result)) return result as T;
    const template = result.template || result.error;
    // Server parameters that name a field or kind ("folder name", "image") are table keys themselves.
    const params = Object.fromEntries(Object.entries(result.params || {})
      .map(([name, value]) => [name, typeof value === 'string' ? translate(value, locale()) : value]));
    throw new RequestError(translate(template, locale(), template, params), result.status, template);
  };
}
