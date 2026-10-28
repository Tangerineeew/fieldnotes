'use strict';

const { bodyPartChars, maxBodyParts } = require('../shared/limits.json');
const { UUID } = require('./common.cjs');

// TREK parses request bodies up to 100 KB. A larger one, such as a long note saved whole or a big paste while co-editing,
// arrives first as numbered parts, each a slice of the body's UTF-8 bytes in base64, and then as `{ parts_id }` in its place.
// Parts belong to the person who sent them and expire after ten minutes; one person holds at most two bodies' worth at a time,
// so nobody can fill the plugin database with parts never claimed.
const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = maxBodyParts * 2;
const PARTS_ID = new RegExp(`^${UUID}$`);

function createParts({ fail }) {
  async function store(ctx, ownerId, input) {
    const { id, part, parts, data } = input || {};
    if (typeof id !== 'string' || !PARTS_ID.test(id) || !Number.isSafeInteger(parts) || parts < 2 || parts > maxBodyParts
      || !Number.isSafeInteger(part) || part < 0 || part >= parts || typeof data !== 'string' || !data.length
      || data.length > bodyPartChars || (part < parts - 1 && data.length % 4) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      fail(400, 'This change is too large to send.');
    const now = Date.now();
    const { results } = await ctx.db.tx([
      { sql: 'DELETE FROM request_parts WHERE created_at < ?', args: [new Date(now - TTL_MS).toISOString()] },
      { sql: `INSERT OR REPLACE INTO request_parts (id, owner_id, part, parts, data, created_at) SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM request_parts WHERE owner_id = ? AND NOT (id = ? AND part = ?)) < ?`,
      args: [id, ownerId, part, parts, data, new Date(now).toISOString(), ownerId, id, part, MAX_PENDING] },
    ]);
    if (results[1].changes !== 1) fail(429, 'Too many changes are on their way. Wait a moment and try again.');
    return { stored: part };
  }

  // The body a `{ parts_id }` request stands for; any other body passes through unchanged.
  async function expand(ctx, ownerId, body) {
    if (!body || typeof body.parts_id !== 'string') return body;
    const rows = await ctx.db.query('SELECT part, parts, data FROM request_parts WHERE id = ? AND owner_id = ? ORDER BY part',
      body.parts_id, ownerId);
    await ctx.db.exec('DELETE FROM request_parts WHERE id = ?', body.parts_id);
    if (!rows.length || rows.length !== rows[0].parts || rows.some((row, index) => row.part !== index))
      fail(400, 'Part of this change did not arrive. Try again.');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(rows.map((row) => row.data).join(''), 'base64').toString('utf8')); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || 'parts_id' in parsed)
      fail(400, 'Part of this change did not arrive. Try again.');
    return parsed;
  }

  return { store, expand };
}

module.exports = { createParts };
