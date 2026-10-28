import * as Y from 'yjs';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import { keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Extension } from '@codemirror/state';
import type { Property } from './properties';
import { RequestError, decodeBase64, encodeBase64, type Invoke } from './api';


// Polling cadence: fast while someone else is in the note, slow when alone, quick flush after local edits.
// A sync costs 2 host calls idle and 4 with updates (measured); the plugin's quota is 20/s across all users,
// so each client is held to one sync per second and edits typed in between are merged into that sync.
const WITH_OTHERS_MS = 1000;
const ALONE_MS = 4000;
const FLUSH_MS = 300;
const MIN_GAP_MS = 1000;
const MAX_BACKOFF_MS = 15000;

export type Peer = { client_id: number; user_id: number; name: string; color: string };
export type CollabStatus = 'connecting' | 'synced' | 'saving' | 'offline' | 'failed';
type SyncResult = { seq: number; state?: string; updates: string[]; presence: (Peer & { cursor: unknown })[] };
type JoinResult = SyncResult & { me: { name: string; color: string } };

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly title = this.doc.getText('title');
  readonly content = this.doc.getText('content');
  readonly properties = this.doc.getMap<Property & { position: number }>('properties');
  readonly meta = this.doc.getMap<string>('meta');
  readonly awareness = new Awareness(this.doc);
  status: CollabStatus = 'connecting';
  private seq = -1;
  // Who else is in the note, which sets how often to sync; their cursors are drawn from Awareness.
  private peers = 0;
  private pending: Uint8Array[] = [];
  private timer = 0;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private lastSync = 0;
  private stopped = false;
  private closed = false;
  private touched = false;
  // Background tabs get their timers throttled; catch up the moment the tab is visible again.
  private readonly onVisible = () => { if (document.visibilityState === 'visible' && !this.stopped) void this.sync(); };

  constructor(private readonly noteId: string, private readonly invoke: Invoke, private readonly onChange: (session: CollabSession) => void,
    private readonly onFailure: (message: string) => void) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      this.touched = true; this.pending.push(update); this.setStatus('saving'); this.schedule(FLUSH_MS);
    });
  }

  private post<T>(action: string, body: Record<string, unknown>) {
    return this.invoke<T>('/collab', { method: 'POST', body: { action, note_id: this.noteId, client_id: this.doc.clientID, ...body } });
  }

  private setStatus(status: CollabStatus) {
    if (this.status !== status) { this.status = status; this.onChange(this); }
  }

  private apply(result: SyncResult) {
    Y.transact(this.doc, () => {
      if (result.state) Y.applyUpdate(this.doc, decodeBase64(result.state), 'remote');
      for (const update of result.updates) Y.applyUpdate(this.doc, decodeBase64(update), 'remote');
    }, 'remote');
    this.seq = result.seq;
    this.applyPresence(result.presence);
  }

  // Remote cursors arrive through our own poll, so they are written into Awareness here instead of y-protocols' wire format.
  private applyPresence(presence: SyncResult['presence']) {
    const now = Date.now(); const added: number[] = []; const updated: number[] = [];
    const live = new Set(presence.map((peer) => peer.client_id));
    for (const peer of presence) {
      const state = { user: { name: peer.name, color: peer.color, colorLight: `${peer.color}33` }, cursor: peer.cursor };
      const previous = this.awareness.states.get(peer.client_id);
      (previous ? updated : added).push(peer.client_id);
      this.awareness.states.set(peer.client_id, state);
      this.awareness.meta.set(peer.client_id, { clock: (this.awareness.meta.get(peer.client_id)?.clock ?? 0) + 1, lastUpdated: now });
    }
    const gone = [...this.awareness.states.keys()].filter((id) => id !== this.doc.clientID && !live.has(id));
    if (gone.length) removeAwarenessStates(this.awareness, gone, 'remote');
    if (added.length || updated.length) this.awareness.emit('change', [{ added, updated, removed: [] }, 'remote']);
    this.peers = presence.length;
  }

  async start() {
    const joined = await this.post<JoinResult>('join', {});
    this.apply(joined);
    this.awareness.setLocalStateField('user', { name: joined.me.name, color: joined.me.color, colorLight: `${joined.me.color}33` });
    this.setStatus('synced');
    document.addEventListener('visibilitychange', this.onVisible);
    this.schedule(this.peers ? WITH_OTHERS_MS : ALONE_MS);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.sync(), Math.max(delay, this.lastSync + MIN_GAP_MS - Date.now()));
  }

  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.round().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async round() {
    window.clearTimeout(this.timer);
    this.lastSync = Date.now();
    const batch = this.pending.splice(0);
    const updates = batch.length ? [encodeBase64(Y.mergeUpdates(batch))] : [];
    try {
      const result = await this.post<SyncResult>('sync', { since: this.seq, updates,
        cursor: this.awareness.getLocalState()?.cursor ?? null });
      this.failures = 0; this.apply(result);
      this.setStatus(this.pending.length ? 'saving' : 'synced');
    } catch (error) {
      // A request error carries its HTTP status. A 4xx (invalid content, lost access, out of sync) is final;
      // network errors, 5xx and throttling (408/429) are retried with backoff.
      const code = error instanceof RequestError ? error.code : 0;
      const message = error instanceof Error ? error.message : String(error);
      if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
        this.stopped = true; this.setStatus('failed'); this.onFailure(message);
        return;
      }
      this.pending.unshift(...batch); this.failures += 1; this.setStatus('offline');
      this.schedule(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.failures));
      return;
    }
    this.schedule(this.pending.length ? FLUSH_MS : this.peers ? WITH_OTHERS_MS : ALONE_MS);
  }

  get unsaved() { return this.pending.length > 0 || this.inFlight !== null; }
  // Whether this visit changed anything, so leaving says "saved" only when there was something to save.
  get edited() { return this.touched; }

  editorExtensions(): Extension[] {
    return [yCollab(this.content, this.awareness), keymap.of(yUndoManagerKeymap)];
  }

  // Flushes local edits before leaving so closing the editor never drops the last keystrokes.
  // `stopped` only halts syncing (also set after a fatal error); `closed` guarantees teardown runs exactly once.
  async stop() {
    if (this.closed) return;
    this.closed = true;
    try { if (!this.stopped && (this.pending.length || this.inFlight)) await this.sync(); } finally {
      this.stopped = true; window.clearTimeout(this.timer); document.removeEventListener('visibilitychange', this.onVisible);
      await this.post('leave', {}).catch(() => {});
      this.awareness.destroy(); this.doc.destroy();
    }
  }
}

// Minimal edit so a remote cursor in the same field keeps its place.
export function replaceText(text: Y.Text, value: string) {
  const current = text.toString();
  if (current === value) return;
  let start = 0;
  while (start < current.length && start < value.length && current[start] === value[start]) start += 1;
  let end = 0;
  while (end < current.length - start && end < value.length - start
    && current[current.length - 1 - end] === value[value.length - 1 - end]) end += 1;
  text.doc!.transact(() => { text.delete(start, current.length - start - end);
    text.insert(start, value.slice(start, value.length - end)); });
}

export function propertiesOf(session: CollabSession): Property[] {
  return [...session.properties.values()].sort((a, b) => a.position - b.position).map(({ position: _position, ...property }) => property);
}

export function setProperties(session: CollabSession, next: Property[]) {
  session.doc.transact(() => {
    const ids = new Set(next.map((property) => property.id));
    for (const key of [...session.properties.keys()]) if (!ids.has(key)) session.properties.delete(key);
    next.forEach((property, position) => {
      const value = { ...property, position };
      if (JSON.stringify(session.properties.get(property.id)) !== JSON.stringify(value)) session.properties.set(property.id, value);
    });
  });
}
