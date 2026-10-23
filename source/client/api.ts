import { translate, type Vars } from './i18n';


export type Invoke = <T>(path: string, options?: { method: string; body: unknown }) => Promise<T>;
type Envelope = { error: string; status: number; template?: string; params?: Vars };

// `code` is the HTTP status (the collab session tells fatal from retryable by it); `template` is the English
// message, so callers can recognise a failure without depending on the translated text.
export class RequestError extends Error {
  constructor(message: string, readonly code: number, readonly template: string) { super(message); }
}

const isEnvelope = (value: unknown): value is Envelope => typeof value === 'object' && value !== null
  && typeof (value as Envelope).error === 'string' && typeof (value as Envelope).status === 'number';

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
