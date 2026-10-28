'use strict';

const Y = require('yjs');
const { maxContentBytes, maxPropertiesBytes, maxTitleChars } = require('../shared/limits.json');
const { personName } = require('./common.cjs');
const { NOTES } = require('./history.cjs');

// Real-time co-editing over polling: TREK forwards no push events to the library page, so clients exchange Yjs updates and
// cursors through `/collab`. An idle poll is budgeted to ~2 host calls, and a sync that carries changes adds only its writes,
// because the plugin's host RPC quota (20/s sustained) is shared by every user.
const PRESENCE_TTL_MS = 10000;
const ACCESS_TTL_MS = 10000;
// The update log folds into the stored state once it holds 100 updates or outweighs that state (64 KB at least), and whenever
// someone joins, so a note edited a while and left never makes later sessions replay its whole log.
const COMPACT_AFTER = 100;
const COMPACT_CHARS = 64 * 1024;
// One update can carry a whole note pasted at once, plus Yjs's own bookkeeping, in base64.
const maxUpdateChars = Math.ceil((maxContentBytes + maxPropertiesBytes) * 1.5 / 3) * 4;
const ROOTS = new Set(['title', 'content', 'properties', 'meta']);
const COLORS = ['#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#f97316', '#3b82f6', '#14b8a6', '#ef4444'];
// Each person keeps one colour everywhere they appear: co-editing cursors, avatars and comment authors.
const personColor = (userId) => COLORS[userId % COLORS.length];
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const whenValid = (check) => {
  try { return check(); } catch (error) { if (error.status === 400) return undefined; throw error; }
};

// Library notes write to `notes`; a trip's snapshot plugs in its own `source` (the row its text is written to, as history.cjs
// describes it), `id` (its key) and `editable` (who may edit it), and shares everything else here.
function createCollab({ fail, id, editable, noteFields, propertyFields, noteIcon, referenceOps, beforeWrite, sweep, source = NOTES }) {
  const { table, match, args: where, live } = source;
  const accessCache = new Map();
  const locks = new Map();
  // Last presence written per session: an unchanged cursor is rewritten only when half its lifetime has passed.
  const written = new Map();

  const clientId = (value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail(400, 'Invalid collaboration client.');
    return value;
  };
  // Serialises writes per note: interleaved awaits would otherwise hand out the same sequence number twice.
  function locked(noteId, fn) {
    const run = (locks.get(noteId) || Promise.resolve()).then(fn, fn);
    locks.set(noteId, run.catch(() => {}));
    return run;
  }
  // Re-checked at most every 10 s per user and note, so a revoked editor is locked out within that window.
  async function requireEditor(ctx, userId, noteId, fresh = false) {
    const key = `${userId}:${noteId}`; const cached = accessCache.get(key);
    if (!fresh && cached && cached.until > Date.now()) return cached.note;
    const note = await editable(ctx, userId, noteId);
    accessCache.set(key, { note, until: Date.now() + ACCESS_TTL_MS });
    return note;
  }
  const person = async (ctx, userId) => ({ name: await personName(ctx, userId), color: personColor(userId) });
  // Fields a half-typed document leaves undefined keep their stored value.
  const write = (noteId, fields, now) => ({ sql: `UPDATE ${table} SET title = COALESCE(?, title), content = ?,
    properties = COALESCE(?, properties), icon = CASE WHEN ? THEN icon ELSE ? END, updated_at = ?, version = version + 1
    WHERE ${match}${live}`, args: [fields.title ?? null, fields.content, fields.properties ?? null, fields.icon === undefined ? 1 : 0,
    fields.icon ?? null, now, ...where(noteId)] });
  const version = async (ctx, noteId) => (await ctx.db.query(`SELECT version FROM ${table} WHERE ${match}`, ...where(noteId)))[0].version;

  function seed(note) {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getText('title').insert(0, note.title);
      doc.getText('content').insert(0, note.content);
      note.properties.forEach((property, position) => doc.getMap('properties').set(property.id, { ...property, position }));
      if (note.icon) doc.getMap('meta').set('icon', note.icon);
    });
    return Y.encodeStateAsUpdate(doc);
  }
  async function load(ctx, noteId) {
    const rows = await ctx.db.query(`SELECT 0 AS pending, state AS data, seq FROM note_crdt WHERE note_id = ?
      UNION ALL SELECT 1, data, seq FROM note_updates WHERE note_id = ? ORDER BY pending, seq`, noteId, noteId);
    if (!rows.length || rows[0].pending) return null;
    const doc = new Y.Doc();
    for (const row of rows) Y.applyUpdate(doc, bytes(row.data));
    return { doc, base: rows[0].seq, seq: rows[rows.length - 1].seq, pending: rows.length - 1, stateChars: rows[0].data.length,
      pendingChars: rows.slice(1).reduce((total, row) => total + row.data.length, 0) };
  }
  const compaction = (noteId, doc, last) => [
    { sql: 'UPDATE note_crdt SET state = ?, seq = ? WHERE note_id = ?', args: [b64(Y.encodeStateAsUpdate(doc)), last, noteId] },
    { sql: 'DELETE FROM note_updates WHERE note_id = ? AND seq <= ?', args: [noteId, last] }];
  async function ensure(ctx, note) {
    await ctx.db.exec('INSERT OR IGNORE INTO note_crdt (note_id, state, seq) VALUES (?, ?, 0)', note.id, b64(seed(note)));
    return load(ctx, note.id);
  }
  // The shared document is validated with the same rules as a plain save before anything is stored.
  function materialize(doc, previous) {
    // Anything outside the four known roots (or meta keys other than the icon) would be stored but never validated.
    if ([...doc.share.keys()].some((name) => !ROOTS.has(name)) || [...doc.getMap('meta').keys()].some((key) => key !== 'icon'))
      fail(400, 'Invalid collaboration update.');
    const properties = [...doc.getMap('properties').values()].sort((a, b) => a.position - b.position)
      .map(({ position, ...property }) => property);
    if (Buffer.byteLength(JSON.stringify(properties), 'utf8') > maxPropertiesBytes)
      fail(400, 'Properties must fit within {size} KB.', { size: maxPropertiesBytes / 1000 });
    const title = doc.getText('title').toString().trim();
    const { content } = noteFields({ title: previous.title, content: doc.getText('content').toString() });
    // Half-typed values (an empty title or property name, a URL without its scheme yet) are undefined, so the stored
    // value stays until the editor finishes; failing would end the session and drop everything typed after.
    return { title: title && title.length <= maxTitleChars ? title : undefined, content,
      properties: whenValid(() => propertyFields(properties)), icon: whenValid(() => noteIcon(doc.getMap('meta').get('icon') ?? null)) };
  }
  async function writes(ctx, noteId, userId, updates, loaded, previous, before) {
    const fields = materialize(loaded.doc, previous); const now = new Date().toISOString();
    const encoded = updates.map((update) => b64(update.data));
    const ops = [...beforeWrite(noteId, userId), ...updates.map((update, index) => ({
      sql: 'INSERT INTO note_updates (note_id, seq, client_id, data) VALUES (?, ?, ?, ?)',
      args: [noteId, loaded.seq + index + 1, update.client, encoded[index]],
    }))];
    ops.push(write(noteId, fields, now), ...await referenceOps(ctx, noteId, before, fields.content));
    const last = loaded.seq + updates.length;
    const pendingChars = loaded.pendingChars + encoded.reduce((total, text) => total + text.length, 0);
    if (loaded.pending + updates.length >= COMPACT_AFTER || pendingChars > Math.max(loaded.stateChars, COMPACT_CHARS))
      ops.push(...compaction(noteId, loaded.doc, last));
    return { ops, seq: last };
  }

  async function push(ctx, note, userId, client, encoded) {
    if (!Array.isArray(encoded) || encoded.length > 50) fail(400, 'Invalid collaboration updates.');
    if (!encoded.length) return null;
    return locked(note.id, async () => {
      const loaded = await load(ctx, note.id) || await ensure(ctx, note);
      const before = loaded.doc.getText('content').toString();
      const updates = encoded.map((text) => {
        if (typeof text !== 'string' || text.length > maxUpdateChars) fail(400, 'Invalid collaboration update.');
        const data = bytes(text);
        try { Y.applyUpdate(loaded.doc, data); } catch { fail(400, 'Invalid collaboration update.'); }
        return { client, data };
      });
      // Yjs parks updates whose predecessors it never saw; storing them would silently fork this client from everyone else.
      if (loaded.doc.store.pendingStructs || loaded.doc.store.pendingDs)
        fail(409, 'This editing session is out of sync. Rejoin to continue.');
      const { ops, seq } = await writes(ctx, note.id, userId, updates, loaded, note, before);
      await ctx.db.tx(ops);
      return seq;
    });
  }
  async function presence(ctx, noteId, userId, client, cursor, fresh = false) {
    const text = cursor === null || cursor === undefined ? null : JSON.stringify(cursor);
    if (text && text.length > 2000) fail(400, 'Invalid cursor.');
    const key = `${noteId}:${client}`; const last = written.get(key); const now = Date.now();
    if (!fresh && last?.text === text && last.userId === userId && now - last.at < PRESENCE_TTL_MS / 2) return;
    await ctx.db.exec(`INSERT INTO note_presence (note_id, client_id, user_id, cursor, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(note_id, client_id) DO UPDATE SET user_id = excluded.user_id, cursor = excluded.cursor, seen_at = excluded.seen_at`,
      noteId, client, userId, text, now);
    written.set(key, { text, userId, at: now });
  }
  // One query returns both the missed updates and the live cursors of everyone else.
  async function changes(ctx, noteId, client, since) {
    const rows = await ctx.db.query(`SELECT 'state' AS kind, seq, state AS data, NULL AS client_id, NULL AS user_id, NULL AS cursor
      FROM note_crdt WHERE note_id = ?
      UNION ALL SELECT 'update', seq, data, client_id, NULL, NULL FROM note_updates WHERE note_id = ? AND seq > ?
      UNION ALL SELECT 'presence', NULL, NULL, client_id, user_id, cursor
        FROM note_presence WHERE note_id = ? AND seen_at > ? AND client_id != ?
      ORDER BY seq`, noteId, noteId, since, noteId, Date.now() - PRESENCE_TTL_MS, client);
    const state = rows.find((row) => row.kind === 'state');
    const updates = rows.filter((row) => row.kind === 'update');
    const seq = Math.max(since, state?.seq ?? 0, ...updates.map((row) => row.seq));
    // A client behind the last compaction gets the compacted state plus every later update; Yjs merges both idempotently.
    const stale = Boolean(state) && since < state.seq;
    const others = rows.filter((row) => row.kind === 'presence');
    const people = await Promise.all(others.map((row) => person(ctx, row.user_id)));
    return {
      seq, state: stale ? state.data : undefined,
      updates: (stale ? updates : updates.filter((row) => row.client_id !== client)).map((row) => row.data),
      presence: others.map((row, index) => ({ client_id: row.client_id, user_id: row.user_id, ...people[index],
        cursor: row.cursor ? JSON.parse(row.cursor) : null })),
    };
  }

  async function action(input, ctx, userId) {
    const noteId = id(input.note_id);
    if (input.action === 'leave') {
      written.delete(`${noteId}:${input.client_id}`);
      await ctx.db.exec('DELETE FROM note_presence WHERE note_id = ? AND client_id = ? AND user_id = ?',
        noteId, clientId(input.client_id), userId);
      return { left: true };
    }
    const client = clientId(input.client_id);
    if (input.action === 'join') {
      const note = await requireEditor(ctx, userId, noteId, true);
      const expired = Date.now() - PRESENCE_TTL_MS;
      for (const [key, last] of written) if (last.at < expired) written.delete(key);
      await ctx.db.exec('DELETE FROM note_presence WHERE seen_at < ?', expired); await sweep(ctx, noteId);
      await locked(noteId, async () => {
        const loaded = await load(ctx, noteId) || await ensure(ctx, note);
        if (loaded.pending) await ctx.db.tx(compaction(noteId, loaded.doc, loaded.seq));
      });
      await presence(ctx, noteId, userId, client, null, true);
      return { ...await changes(ctx, noteId, client, -1), me: await person(ctx, userId), version: await version(ctx, noteId) };
    }
    if (input.action === 'sync') {
      const note = await requireEditor(ctx, userId, noteId);
      const since = Number.isSafeInteger(input.since) && input.since >= 0 ? input.since : fail(400, 'Invalid collaboration sequence.');
      await push(ctx, note, userId, client, input.updates || []);
      await presence(ctx, noteId, userId, client, input.cursor);
      return changes(ctx, noteId, client, since);
    }
    fail(400, 'Unknown collaboration action.');
  }

  // A plain save (older clients, other callers) becomes one more Yjs update, so open sessions converge on it.
  async function external(ctx, note) {
    return locked(note.id, async () => {
      const loaded = await load(ctx, note.id);
      if (!loaded) return;
      const captured = [];
      loaded.doc.on('update', (update) => captured.push(update));
      loaded.doc.transact(() => {
        replace(loaded.doc.getText('title'), note.title); replace(loaded.doc.getText('content'), note.content);
        const meta = loaded.doc.getMap('meta');
        if ((meta.get('icon') ?? null) !== (note.icon ?? null)) { if (note.icon) meta.set('icon', note.icon); else meta.delete('icon'); }
        const map = loaded.doc.getMap('properties'); const ids = new Set(note.properties.map((property) => property.id));
        for (const key of [...map.keys()]) if (!ids.has(key)) map.delete(key);
        note.properties.forEach((property, position) => {
          const next = { ...property, position };
          if (JSON.stringify(map.get(property.id)) !== JSON.stringify(next)) map.set(property.id, next);
        });
      });
      if (!captured.length) return;
      await ctx.db.tx([{ sql: 'INSERT INTO note_updates (note_id, seq, client_id, data) VALUES (?, ?, 0, ?)',
        args: [note.id, loaded.seq + 1, b64(Y.mergeUpdates(captured))] }]);
    });
  }

  return { action, external,
    forget: (noteId) => { for (const key of accessCache.keys()) if (key.endsWith(`:${noteId}`)) accessCache.delete(key); } };
}

// Minimal edit: keep the common prefix and suffix so concurrent cursors elsewhere stay put.
function replace(text, value) {
  const current = text.toString();
  if (current === value) return;
  let start = 0;
  while (start < current.length && start < value.length && current[start] === value[start]) start += 1;
  let end = 0;
  while (end < current.length - start && end < value.length - start
    && current[current.length - 1 - end] === value[value.length - 1 - end]) end += 1;
  text.delete(start, current.length - start - end);
  text.insert(start, value.slice(start, value.length - end));
}

module.exports = { createCollab, personColor };
