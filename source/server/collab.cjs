'use strict';

const Y = require('yjs');
const { maxPropertiesBytes } = require('../shared/limits.json');

// Real-time co-editing over polling: TREK forwards no push events to the library page, so clients
// exchange Yjs updates and cursors through `/collab`. Each round-trip is budgeted to ~2 host calls
// because the plugin's host RPC quota (20/s sustained) is shared by every user.
const PRESENCE_TTL_MS = 10000;
const ACCESS_TTL_MS = 10000;
const COMPACT_AFTER = 100;
const ROOTS = new Set(['title', 'content', 'properties', 'meta']);
const COLORS = ['#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#f97316', '#3b82f6', '#14b8a6', '#ef4444'];
// Each person keeps one colour everywhere they appear: co-editing cursors, avatars and comment authors.
const personColor = (userId) => COLORS[userId % COLORS.length];
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const whenValid = (check) => {
  try { return check(); } catch (error) { if (error.status === 400) return undefined; throw error; }
};

function createCollab({ fail, id, editable, noteFields, propertyFields, noteIcon, referenceOps, sweep }) {
  const accessCache = new Map();
  const nameCache = new Map();
  const locks = new Map();

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
  async function person(ctx, userId) {
    if (!nameCache.has(userId)) {
      const user = await ctx.users.getById(userId).catch(() => null);
      nameCache.set(userId, user?.display_name || user?.username || `#${userId}`);
    }
    return { name: nameCache.get(userId), color: personColor(userId) };
  }

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
    return { doc, base: rows[0].seq, seq: rows[rows.length - 1].seq, pending: rows.length - 1 };
  }
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
    return { title: title && title.length <= 160 ? title : undefined, content, properties: whenValid(() => propertyFields(properties)),
      icon: whenValid(() => noteIcon(doc.getMap('meta').get('icon') ?? null)) };
  }
  function writes(noteId, updates, doc, previous, before, seq, pending) {
    const fields = materialize(doc, previous); const now = new Date().toISOString();
    const ops = updates.map((update, index) => ({
      sql: 'INSERT INTO note_updates (note_id, seq, client_id, data) VALUES (?, ?, ?, ?)',
        args: [noteId, seq + index + 1, update.client, b64(update.data)],
    }));
    ops.push({ sql: `UPDATE notes SET title = COALESCE(?, title), content = ?, properties = COALESCE(?, properties),
      icon = CASE WHEN ? THEN icon ELSE ? END, updated_at = ?, version = version + 1 WHERE id = ? AND archived = 0`,
      args: [fields.title ?? null, fields.content, fields.properties ?? null, fields.icon === undefined ? 1 : 0, fields.icon ?? null, now, noteId] },
    ...referenceOps(before, fields.content));
    const last = seq + updates.length;
    if (pending + updates.length >= COMPACT_AFTER) {
      ops.push({ sql: 'UPDATE note_crdt SET state = ?, seq = ? WHERE note_id = ?', args: [b64(Y.encodeStateAsUpdate(doc)), last, noteId] },
        { sql: 'DELETE FROM note_updates WHERE note_id = ? AND seq <= ?', args: [noteId, last] });
    }
    return { ops, seq: last };
  }

  async function push(ctx, note, client, encoded) {
    if (!Array.isArray(encoded) || encoded.length > 50) fail(400, 'Invalid collaboration updates.');
    if (!encoded.length) return null;
    return locked(note.id, async () => {
      const loaded = await load(ctx, note.id) || await ensure(ctx, note);
      const before = loaded.doc.getText('content').toString();
      const updates = encoded.map((text) => {
        if (typeof text !== 'string' || text.length > 200000) fail(400, 'Invalid collaboration update.');
        const data = bytes(text);
        try { Y.applyUpdate(loaded.doc, data); } catch { fail(400, 'Invalid collaboration update.'); }
        return { client, data };
      });
      // Yjs parks updates whose predecessors it never saw; storing them would silently fork this client from everyone else.
      if (loaded.doc.store.pendingStructs || loaded.doc.store.pendingDs)
        fail(409, 'This editing session is out of sync. Rejoin to continue.');
      const { ops, seq } = writes(note.id, updates, loaded.doc, note, before, loaded.seq, loaded.pending);
      await ctx.db.tx(ops);
      return seq;
    });
  }
  async function presence(ctx, noteId, userId, client, cursor) {
    const text = cursor === null || cursor === undefined ? null : JSON.stringify(cursor);
    if (text && text.length > 2000) fail(400, 'Invalid cursor.');
    await ctx.db.exec(`INSERT INTO note_presence (note_id, client_id, user_id, cursor, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(note_id, client_id) DO UPDATE SET user_id = excluded.user_id, cursor = excluded.cursor, seen_at = excluded.seen_at`,
      noteId, client, userId, text, Date.now());
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
      await ctx.db.exec('DELETE FROM note_presence WHERE note_id = ? AND client_id = ? AND user_id = ?',
        noteId, clientId(input.client_id), userId);
      return { left: true };
    }
    const client = clientId(input.client_id);
    if (input.action === 'join') {
      const note = await requireEditor(ctx, userId, noteId, true);
      await ctx.db.exec('DELETE FROM note_presence WHERE seen_at < ?', Date.now() - PRESENCE_TTL_MS); await sweep(ctx);
      await locked(noteId, () => load(ctx, noteId).then((loaded) => loaded || ensure(ctx, note)));
      await presence(ctx, noteId, userId, client, null);
      const [{ version }] = await ctx.db.query('SELECT version FROM notes WHERE id = ?', noteId);
      return { ...await changes(ctx, noteId, client, -1), me: await person(ctx, userId), version };
    }
    if (input.action === 'sync') {
      const note = await requireEditor(ctx, userId, noteId);
      const since = Number.isSafeInteger(input.since) && input.since >= 0 ? input.since : fail(400, 'Invalid collaboration sequence.');
      await push(ctx, note, client, input.updates || []);
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
