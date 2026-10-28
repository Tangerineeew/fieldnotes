'use strict';

const { randomUUID } = require('node:crypto');
const { parseList, personName } = require('./common.cjs');

// Version history. A version is a note as it stood when a stretch of editing ended: the first change after ten quiet minutes,
// or after an hour of steady editing, keeps what came before it. Older versions thin out the way backups do: every one from
// the last day, the last of each day for a month, the last of each week for a year, at most 100 a note, and the oldest go
// first once all history passes its share of the plugin database.
const QUIET_MS = 10 * 60 * 1000;
const STRETCH_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_NOTE = 100;
const BUDGET_BYTES = 32 * 1024 * 1024;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
// What a version weighs on disk, in UTF-8 bytes rather than characters, image icons included; stored with the version so the
// budget below adds up integers instead of measuring every text again.
const VERSION_BYTES = `length(CAST(title AS BLOB)) + length(CAST(content AS BLOB)) + length(CAST(properties AS BLOB))
  + COALESCE(length(CAST(icon AS BLOB)), 0)`;

// Where the versioned text lives: a library note by its id, or a trip's snapshot by `trip:<trip id>:<note id>`. Both keep their
// versions in `note_versions` under that key, and co-editing writes through the same description (see collab.cjs).
const NOTES = { table: 'notes', match: 'id = ?', args: (key) => [key], live: ' AND archived = 0' };
const snapshotKey = (tripId, noteId) => `trip:${tripId}:${noteId}`;
const snapshotParts = (key) => { const [, tripId, noteId] = key.split(':'); return { tripId: Number(tripId), noteId }; };
// The same key built in SQL from a row's columns; `alias` names the row's table when the query joins others.
const snapshotKeySql = (alias = '') => `'trip:' || ${alias}trip_id || ':' || ${alias}note_id`;
const SNAPSHOTS = { table: 'trip_note_snapshots', match: 'trip_id = ? AND note_id = ?', live: '',
  args: (key) => { const { tripId, noteId } = snapshotParts(key); return [tripId, noteId]; } };

function createHistory({ fail, editable, source = NOTES }) {
  let prunedAt = 0;
  const { table, match, args: where, live } = source;

  // Runs in the same transaction as a change to a note, before the note is written, so it reads the state being replaced.
  // `force` keeps that state whatever the timing (a restore); `version` makes both steps a no-op when the change will lose
  // a version check.
  function beforeWrite(noteId, userId, { force = false, version } = {}) {
    const now = Date.now();
    const starts = force ? '1' : '(updated_at < ? OR burst_at IS NULL OR burst_at < ?)';
    const cutoffs = force ? [] : [iso(now - QUIET_MS), iso(now - STRETCH_MS)];
    const guard = version === undefined ? '' : ' AND version = ?'; const expected = version === undefined ? [] : [version];
    return [{ sql: `INSERT INTO note_versions (id, note_id, edited_at, editors, title, icon, properties, content, bytes)
      SELECT ?, ?, updated_at, edited_by, title, icon, properties, content, ${VERSION_BYTES} FROM ${table} WHERE ${match}${live}${guard}
      AND ${starts} AND (content != '' OR properties != '[]')
      AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = ? AND v.edited_at = ${table}.updated_at)`,
      args: [randomUUID(), noteId, ...where(noteId), ...expected, ...cutoffs, noteId] },
    // Who edits since the last version is kept on the note, so the next version can name them.
    { sql: `UPDATE ${table} SET burst_at = CASE WHEN ${starts} THEN ? ELSE burst_at END,
      edited_by = CASE WHEN ${starts} THEN json_array(?) WHEN EXISTS (SELECT 1 FROM json_each(edited_by) WHERE value = ?)
        THEN edited_by ELSE json_insert(edited_by, '$[#]', ?) END WHERE ${match}${guard}`,
      args: [...cutoffs, iso(now), ...cutoffs, userId, userId, userId, ...where(noteId), ...expected] }];
  }

  // Drops what the schedule above no longer keeps, the history of notes and snapshots deleted permanently, and the oldest
  // versions past the budget. A deleted note keeps its history while it can be recovered. Joining a note runs this at most
  // every ten minutes; opening a history always does, so the list never shows what is due to go.
  async function prune(ctx, always = false) {
    const now = Date.now();
    if (!always && now - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now;
    await ctx.db.tx([
      { sql: `DELETE FROM note_versions WHERE CASE WHEN note_id LIKE 'trip:%'
        THEN note_id NOT IN (SELECT ${snapshotKeySql()} FROM trip_note_snapshots)
        ELSE note_id NOT IN (SELECT id FROM notes) END` },
      { sql: `DELETE FROM note_versions WHERE id IN (SELECT id FROM (SELECT id, edited_at,
        ROW_NUMBER() OVER (PARTITION BY note_id, substr(edited_at, 1, 10) ORDER BY edited_at DESC) AS in_day,
        ROW_NUMBER() OVER (PARTITION BY note_id, strftime('%Y-%W', edited_at) ORDER BY edited_at DESC) AS in_week,
        ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY edited_at DESC) AS newest FROM note_versions)
        WHERE edited_at < ? OR newest > ? OR (edited_at < ? AND in_week > 1) OR (edited_at < ? AND in_day > 1))`,
      args: [iso(now - 365 * DAY_MS), PER_NOTE, iso(now - 30 * DAY_MS), iso(now - DAY_MS)] },
      { sql: `DELETE FROM note_versions WHERE id IN (SELECT id FROM (SELECT id,
        SUM(bytes) OVER (ORDER BY edited_at DESC, id DESC) AS kept FROM note_versions)
        WHERE kept > ?)`, args: [BUDGET_BYTES] },
    ]);
  }

  async function people(ctx, ids) {
    const names = new Map(await Promise.all(ids.map(async (userId) => [userId, await personName(ctx, userId)])));
    return (list) => list.map((userId) => ({ id: userId, name: names.get(userId) }));
  }

  // Only people who may edit a note see its history: it can hold text an editor has since taken out.
  async function list(ctx, userId, noteId) {
    const note = await editable(ctx, userId, noteId);
    await prune(ctx, true);
    const rows = await ctx.db.query(`SELECT id, edited_at, editors, title, icon, length(content) AS length FROM note_versions
      WHERE note_id = ? ORDER BY edited_at DESC`, note.id);
    const [row] = await ctx.db.query(`SELECT edited_by FROM ${table} WHERE ${match}`, ...where(note.id));
    const editing = parseList(row?.edited_by);
    const named = await people(ctx, [...new Set([...editing, ...rows.flatMap((version) => parseList(version.editors))])]);
    return { current: { edited_at: note.updated_at, editors: named(editing), title: note.title,
      length: note.content.length },
      versions: rows.map((version) => ({ id: version.id, edited_at: version.edited_at, editors: named(parseList(version.editors)),
        title: version.title, icon: version.icon && !version.icon.startsWith('data:') ? version.icon : null, length: version.length })) };
  }

  async function read(ctx, userId, noteId, versionId) {
    const note = await editable(ctx, userId, noteId);
    const [version] = await ctx.db.query(`SELECT id, edited_at, title, icon, properties, content FROM note_versions
      WHERE id = ? AND note_id = ?`, String(versionId || ''), note.id);
    if (!version) fail(404, 'This version is no longer kept.');
    return { ...version, properties: parseList(version.properties) };
  }

  return { beforeWrite, prune, list, read };
}

module.exports = { createHistory, snapshotKey, snapshotParts, snapshotKeySql, NOTES, SNAPSHOTS, VERSION_BYTES };
