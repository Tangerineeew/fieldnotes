'use strict';

const { randomUUID } = require('node:crypto');
const { uploadPartChars, maxImageBytes, maxPdfBytes } = require('../shared/limits.json');
const { UUID } = require('./common.cjs');

// Uploaded images and PDFs live in the plugin's own database. TREK caps plugin route bodies at 100 KB, so the client
// sends base64 parts in order and the last one assembles the file.
const ASSET_SOURCE = new RegExp(`^fieldnotes://asset/(${UUID})$`);
const ASSET_REFERENCE = new RegExp(`fieldnotes://asset/(${UUID})`, 'g');
const UPLOAD_ID = new RegExp(`^${UUID}$`);
const MAX_PARTS = Math.ceil(Math.ceil(Math.max(maxImageBytes, maxPdfBytes) / 3) * 4 / uploadPartChars);
// TREK caps each plugin's ctx.db at 256 MB. Uploads, stored as base64 alongside snapshot copies, may fill half of it.
const MAX_STORED_BYTES = 256 * 1024 * 1024 / 2 * 3 / 4;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
// A removed image survives a short window for undo; an upload never saved into a note survives a day of drafting.
const RELEASE_GRACE_MS = 10 * 60 * 1000;
const UNUSED_GRACE_MS = 24 * 60 * 60 * 1000;
const SIGNATURES = [
  ['image/png', (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/gif', (bytes) => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))],
  ['image/webp', (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/avif', (bytes) => bytes.subarray(4, 8).toString('latin1') === 'ftyp'
    && /^avi[fs]$/.test(bytes.subarray(8, 12).toString('latin1'))],
  ['application/pdf', (bytes) => bytes.subarray(0, 5).toString('latin1') === '%PDF-'],
];

const assetIds = (content) => new Set([...String(content).matchAll(ASSET_REFERENCE)].map((match) => match[1]));
const sniff = (bytes) => SIGNATURES.find(([, matches]) => matches(bytes))?.[0] || null;

function createAssets({ fail }) {
  const uploadId = (value) => {
    if (typeof value !== 'string' || !UPLOAD_ID.test(value)) fail(400, 'Invalid upload.');
    return value;
  };

  // Writes that stamp uploads a content change stopped using, and clear the stamp on ones it uses again.
  function referenceOps(before, after) {
    const previous = assetIds(before); const next = assetIds(after);
    const added = [...next].filter((assetId) => !previous.has(assetId));
    const removed = [...previous].filter((assetId) => !next.has(assetId));
    const ops = [];
    if (added.length) ops.push({ sql: 'UPDATE note_assets SET released_at = NULL WHERE id IN (SELECT value FROM json_each(?))',
      args: [JSON.stringify(added)] });
    if (removed.length) {
      ops.push({ sql: 'UPDATE note_assets SET released_at = ? WHERE released_at IS NULL AND id IN (SELECT value FROM json_each(?))',
        args: [new Date().toISOString(), JSON.stringify(removed)] });
    }
    return ops;
  }

  async function track(ctx, before, after) {
    const ops = referenceOps(before, after);
    if (ops.length) await ctx.db.tx(ops);
  }

  // Deletes uploads no note (live, or deleted and still recoverable) or kept version mentions once their grace window has passed;
  // snapshots keep their own copies.
  function sweep(ctx) {
    const now = Date.now();
    return ctx.db.exec(`DELETE FROM note_assets WHERE (CASE WHEN released_at IS NULL THEN created_at < ? ELSE released_at < ? END)
      AND NOT EXISTS (SELECT 1 FROM notes WHERE instr(content, 'fieldnotes://asset/' || note_assets.id) > 0)
      AND NOT EXISTS (SELECT 1 FROM note_versions WHERE instr(content, 'fieldnotes://asset/' || note_assets.id) > 0)`,
    new Date(now - UNUSED_GRACE_MS).toISOString(), new Date(now - RELEASE_GRACE_MS).toISOString());
  }

  // Unfinished parts count too, so abandoned uploads cannot fill the plugin database before their TTL sweep.
  async function reserve(ctx, uploadId, adding) {
    const [{ total }] = await ctx.db.query(`SELECT (SELECT COALESCE(SUM(size), 0) FROM note_assets)
      + (SELECT COALESCE(SUM(size), 0) FROM snapshot_assets)
      + (SELECT COALESCE(SUM(length(data)), 0) * 3 / 4 FROM asset_uploads WHERE id != ?) AS total`, uploadId);
    if (total + adding > MAX_STORED_BYTES) fail(413, 'Fieldnotes storage is full. Remove unused images or PDFs first.');
  }

  async function upload(ctx, userId, input) {
    const part = Number(input.part); const parts = Number(input.parts); const data = input.data;
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > MAX_PARTS || !Number.isSafeInteger(part) || part < 0 || part >= parts
      || typeof data !== 'string' || !data.length || data.length > uploadPartChars || data.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      fail(400, 'Invalid upload part.');
    }
    const now = new Date().toISOString();
    const id = part === 0 ? randomUUID() : uploadId(input.upload_id);
    if (part === 0) await ctx.db.exec('DELETE FROM asset_uploads WHERE created_at < ?', new Date(Date.now() - UPLOAD_TTL_MS).toISOString());
    const stored = part === 0 ? []
      : await ctx.db.query('SELECT data FROM asset_uploads WHERE id = ? AND owner_id = ? AND parts = ? ORDER BY part', id, userId, parts);
    if (stored.length !== part) fail(409, 'Upload parts must arrive in order.');
    if (part < parts - 1) {
      await reserve(ctx, id, (part + 1) * data.length * 3 / 4);
      await ctx.db.exec('INSERT INTO asset_uploads (id, owner_id, part, parts, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, userId, part, parts, data, now);
      return { upload_id: id };
    }
    const bytes = Buffer.from([...stored.map((row) => row.data), data].join(''), 'base64');
    const mimetype = sniff(bytes) || fail(415, 'Upload a PNG, JPEG, GIF, WebP or AVIF image, or a PDF.');
    if (mimetype === 'application/pdf' && bytes.length > maxPdfBytes)
      fail(413, 'PDFs must be {size} MB or smaller.', { size: maxPdfBytes / 1024 / 1024 });
    if (mimetype !== 'application/pdf' && bytes.length > maxImageBytes)
      fail(413, 'Images must be {size} MB or smaller.', { size: maxImageBytes / 1024 / 1024 });
    await sweep(ctx);
    await reserve(ctx, id, bytes.length);
    const assetId = randomUUID();
    await ctx.db.tx([
      { sql: 'INSERT INTO note_assets (id, owner_id, mimetype, size, content_base64, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [assetId, userId, mimetype, bytes.length, bytes.toString('base64'), now] },
      { sql: 'DELETE FROM asset_uploads WHERE id = ?', args: [id] },
    ]);
    return { source: `fieldnotes://asset/${assetId}`, mimetype, size: bytes.length };
  }

  // Null for other sources; access is decided by the caller, which only resolves sources its note contains.
  async function read(ctx, source) {
    const match = ASSET_SOURCE.exec(source);
    if (!match) return null;
    const [row] = await ctx.db.query('SELECT mimetype, size, content_base64 FROM note_assets WHERE id = ?', match[1]);
    return row || fail(404, 'This file was deleted.');
  }

  // Several uploads in one query, keyed by source; a source that is no upload, or one since deleted, is left out.
  async function readMany(ctx, sources) {
    const ids = sources.map((source) => ASSET_SOURCE.exec(source)?.[1]).filter(Boolean);
    if (!ids.length) return new Map();
    const rows = await ctx.db.query(`SELECT id, mimetype, size, content_base64 FROM note_assets
      WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    return new Map(rows.map((row) => [`fieldnotes://asset/${row.id}`, row]));
  }

  return { referenceOps, track, sweep, upload, read, readMany, isUpload: (source) => ASSET_SOURCE.test(source) };
}

module.exports = { createAssets };
