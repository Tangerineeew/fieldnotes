'use strict';

const { randomUUID } = require('node:crypto');
const dns = require('node:dns/promises');
const https = require('node:https');
const { isIP } = require('node:net');
const {
  assetBatch, maxImageBytes, maxPdfBytes, maxContentChars, maxContentBytes, maxPropertiesBytes, maxCommentChars, maxQuoteChars, quoteContextChars,
  maxTitleChars, maxIconChars, maxProperties, maxPropertyOptions, maxPropertyNameChars, maxPropertyTextChars, maxChecklistItems,
  propertyColors
} = require('../shared/limits.json');
const { createAssets } = require('./assets.cjs');
const { UUID, parseList } = require('./common.cjs');
const { rank } = require('./search.cjs');
const { createTrekObjects } = require('./trek-objects.cjs');
const { createCollab, personColor } = require('./collab.cjs');
const { createHistory, snapshotKey, snapshotParts, snapshotKeySql, SNAPSHOTS, VERSION_BYTES } = require('./history.cjs');
const { createParts } = require('./parts.cjs');

// `message` is an English template; `{name}` placeholders are filled from `params` here and again, translated, by the client.
class Problem extends Error {
  constructor(status, message, params = {}) {
    super(message.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match)));
    this.status = status; this.template = message; this.params = params;
  }
}
const fail = (status, message, params) => { throw new Problem(status, message, params); };
const number = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(400, 'Invalid trip or day identifier.');
  return n;
};
const idPattern = new RegExp(`^${UUID}$`);
const id = (value) => {
  if (typeof value !== 'string' || !idPattern.test(value)) fail(400, 'Invalid note identifier.');
  return value;
};
const text = (value, max, name) => {
  if (typeof value !== 'string' || value.length > max) fail(400, 'Invalid value: {field}.', { field: name });
  return value;
};
const actor = (req) => {
  if (!req.user || !Number.isSafeInteger(req.user.id)) fail(401, 'Sign in first.');
  return req.user.id;
};
const noteFields = (input) => {
  const title = text(input.title, maxTitleChars, 'title').trim();
  if (!title) fail(400, 'Title is required.');
  const content = text(input.content, maxContentChars, 'content');
  if (Buffer.byteLength(content, 'utf8') > maxContentBytes) {
    fail(400, 'Content must fit within {size} KB.', { size: maxContentBytes / 1000 });
  }
  // Legacy tags: still accepted from older callers, but the client now uses multi-select properties instead.
  if (input.tags === undefined) return { title, content, tags: undefined };
  if (!Array.isArray(input.tags) || input.tags.length > 12) fail(400, 'Use at most 12 tags.');
  const tags = JSON.stringify([...new Set(input.tags.map((tag) => text(tag, 40, 'tag').trim()).filter(Boolean))]);
  return { title, content, tags };
};
// A note icon is either a short emoji/text or a small image the client has already cropped and encoded.
const noteIcon = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(400, 'Invalid note icon.');
  if (value.startsWith('data:')) {
    if (value.length > maxIconChars || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value))
      fail(400, 'Note icon images must be PNG, JPEG, WebP or GIF under 100 KB.');
    return value;
  }
  const icon = value.trim();
  if (!icon || Array.from(icon).length > 16 || /[<>]/.test(icon)) fail(400, 'Invalid note icon.');
  return icon;
};
// Library and trip folders alike.
const folderName = (value) => text(value, 80, 'folder name').trim() || fail(400, 'Folder name is required.');
const folderIcon = (value) => (value ? text(value, 8, 'folder icon').trim() : null);
const propertyValues = {
  text: (value) => text(value ?? '', maxPropertyTextChars, 'text property'),
  number: (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(400, 'Invalid number property.');
    return value;
  },
  date: (value) => {
    if (!value) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
      fail(400, 'Invalid date property.');
    return value;
  },
  checkbox: (value) => value === true,
  url: (value) => {
    const url = text(value ?? '', maxPropertyTextChars, 'URL property').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) fail(400, 'URL properties must start with http:// or https://.');
    return url;
  },
  select: (value, options) => {
    if (!value) return null;
    if (!options.some((option) => option.id === value)) fail(400, 'Invalid select property.');
    return value;
  },
  multi_select: (value, options) => {
    if (!Array.isArray(value) || value.some((item) => !options.some((option) => option.id === item)))
      fail(400, 'Invalid multi-select property.');
    return [...new Set(value)];
  },
  checklist: (value) => {
    if (!Array.isArray(value) || value.length > maxChecklistItems) {
      fail(400, 'Use at most {count} checklist items.', { count: maxChecklistItems });
    }
    return value.map((item) => ({ text: text(item?.text ?? '', 200, 'checklist item'), done: item?.done === true }));
  },
  last_edited: () => null,
};
const propertyId = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) fail(400, 'Invalid property identifier.');
  return value;
};
// Per-note typed properties, stored as one JSON array in the note row.
function propertyFields(raw) {
  if (!Array.isArray(raw) || raw.length > maxProperties) fail(400, 'Use at most {count} properties.', { count: maxProperties });
  const ids = new Set();
  const properties = raw.map((property) => {
    const pid = propertyId(property?.id);
    if (ids.has(pid)) fail(400, 'Duplicate property identifier.');
    ids.add(pid);
    const name = text(property.name, maxPropertyNameChars, 'property name').trim();
    if (!name) fail(400, 'Property name is required.');
    if (!Object.hasOwn(propertyValues, property.type)) fail(400, 'Invalid property type.');
    const choice = property.type === 'select' || property.type === 'multi_select';
    const options = choice ? propertyOptions(property.options) : [];
    return { id: pid, name, type: property.type, value: propertyValues[property.type](property.value, options),
      ...(choice ? { options } : {}) };
  });
  const json = JSON.stringify(properties);
  if (Buffer.byteLength(json, 'utf8') > maxPropertiesBytes) {
    fail(400, 'Properties must fit within {size} KB.', { size: maxPropertiesBytes / 1000 });
  }
  return json;
}
function propertyOptions(raw) {
  if (!Array.isArray(raw) || raw.length > maxPropertyOptions) {
    fail(400, 'Use at most {count} options per property.', { count: maxPropertyOptions });
  }
  return raw.map((option) => {
    const name = text(option?.name, maxPropertyNameChars, 'option name').trim();
    if (!name) fail(400, 'Option name is required.');
    if (!Number.isInteger(option.color) || option.color < 0 || option.color >= propertyColors) fail(400, 'Invalid option color.');
    return { id: propertyId(option.id), name, color: option.color };
  });
}
// Only human-visible values are searchable; the JSON keys and option ids never match a query.
function propertyText(properties) {
  return properties.flatMap((property) => {
    if (property.type === 'select' || property.type === 'multi_select') {
      const chosen = new Set(property.type === 'select' ? [property.value] : property.value || []);
      return (property.options || []).filter((option) => chosen.has(option.id)).map((option) => option.name);
    }
    if (property.type === 'checklist') return (property.value || []).map((item) => item.text);
    return ['text', 'url', 'number', 'date'].includes(property.type) && property.value !== null ? [String(property.value)] : [];
  }).join('\n');
}
// Who is editing and since when only steer version history, and when a note was deleted only Recently deleted shows; they stay
// out of what callers receive.
const decode = (row) => {
  if (!row) return row;
  const { edited_by: _editors, burst_at: _burst, archived_at: _deleted, ...note } = row;
  return { ...note, tags: parseList(row.tags), properties: parseList(row.properties ?? '[]'), visibility: row.visibility || 'private' };
};
const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
const tripFilePattern = /^fieldnotes:\/\/trip-file\/(\d{1,12})\/(\d{1,12})$/;
const pageSize = 7;
const maxListLimit = 500;
const noteSorts = { name: (a, b, collator) => collator.compare(a.title, b.title),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
  updated: (a, b) => a.updated_at.localeCompare(b.updated_at) };
const hostNotAllowed = 'Image host is not allowed. Paste the image itself, or ask an admin to allow this host.';
const maxSnapshotAssetsBytes = 32 * 1024 * 1024;
// The SDK runs at most this many statements in one transaction.
const TX_CAP = 100;
// A snapshot is taken in one transaction: its link and snapshot rows, and a copy of each image.
const maxSnapshotAssets = TX_CAP - 2;
const maxCommentsPerNote = 500;
// What a note may show from `![alt](source)`, and how large: images, and PDFs, which the page draws with pdf.js.
const assetLimits = { 'image/avif': maxImageBytes, 'image/gif': maxImageBytes, 'image/jpeg': maxImageBytes,
  'image/png': maxImageBytes, 'image/webp': maxImageBytes, 'application/pdf': maxPdfBytes };
const allowedImageTypes = new Set(Object.keys(assetLimits).filter((type) => type.startsWith('image/')));

function imageSources(content) {
  const sources = new Set();
  for (const match of String(content).matchAll(imagePattern)) sources.add(match[2]);
  return [...sources];
}

// Null for any other source, including one naming no real trip or file, so a note holding it never fails to save.
function tripFileSource(source) {
  const [, tripId, fileId] = (tripFilePattern.exec(source) || []).map(Number);
  return tripId > 0 && fileId > 0 ? { tripId, fileId } : null;
}

function imageData(content, name = 'image') {
  const mimetype = String(content.mimetype || '').toLowerCase().split(';')[0];
  const size = Number(content.size || 0);
  const limit = Object.hasOwn(assetLimits, mimetype) ? assetLimits[mimetype] : 0;
  if (!limit || !Number.isSafeInteger(size) || size > limit
      || typeof content.content_base64 !== 'string' || content.content_base64.length > Math.ceil(limit * 4 / 3)) {
    fail(415, 'Unsupported format: {kind}.', { kind: name });
  }
  return { mimetype, size, content_base64: content.content_base64, data_url: `data:${mimetype};base64,${content.content_base64}` };
}

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function inIpv4Range(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function ipv6Number(address) {
  const normalized = address.toLowerCase().replace(/\.(\d+)(?=:|$)/g, '.$1');
  const expanded = normalized.includes('.') ? normalized.replace(/([^:]+)$/, (_match, ipv4) => {
    const parts = ipv4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return '';
    return `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }) : normalized;
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, prefix]) => inIpv4Range(address, network, prefix));
  }
  if (isIP(address) !== 6) return false;
  const value = ipv6Number(address);
  if (value === null || (value >> 125n) !== 1n) return false;
  const inRange = (network, prefix) => {
    const shift = BigInt(128 - prefix);
    return value >> shift === ipv6Number(network) >> shift;
  };
  return !inRange('2001:db8::', 32) && !inRange('2001::', 23) && !inRange('2002::', 16) && !inRange('3fff::', 20);
}

function externalUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { fail(400, 'Invalid image URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(400, 'Only credential-free HTTPS images are allowed.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host))) {
    fail(400, 'Private image hosts are not allowed.');
  }
  return url;
}

async function resolvePublicImageHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (error) {
    // TREK's egress guard refuses every host an admin has not allowed for this plugin.
    if (/^egress:/.test(error?.message)) fail(403, hostNotAllowed);
    fail(502, 'Image host could not be resolved.');
  }
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    fail(400, 'Private image hosts are not allowed.');
  }
  return addresses;
}

function pinnedLookup(url, addresses) {
  // The socket lookup must use only the addresses already checked above.
  const expectedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const requestedHost = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (requestedHost !== expectedHost) return callback(new Error('Unexpected image host lookup.'));
    const selected = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
    if (!selected.length) return callback(Object.assign(new Error('No pinned address for requested family.'), { code: 'EAI_ADDRFAMILY' }));
    if (options.all) return callback(null, selected);
    return callback(null, selected[0].address, selected[0].family);
  };
}

function requestPinnedImage(url, addresses) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const options = { agent: false, headers: { accept: 'image/*' }, signal: AbortSignal.timeout(8000) };
  if (!isIP(host)) {
    options.lookup = pinnedLookup(url, addresses);
    options.servername = host;
  }
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, resolve);
    request.once('error', (error) => reject(/^egress:/.test(error?.message) ? new Problem(403, hostNotAllowed) : error));
    request.end();
  });
}

async function readImageBody(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxImageBytes) {
      response.destroy();
      fail(415, 'Image exceeds the size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function fetchExternalImage(raw) {
  let url = externalUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const addresses = await resolvePublicImageHost(url);
    const response = await requestPinnedImage(url, addresses);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 3) fail(502, 'Image redirect limit reached.');
      url = externalUrl(new URL(location, url).href);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      fail(502, 'Image could not be loaded.');
    }
    const type = String(response.headers['content-type'] || '').toLowerCase().split(';')[0];
    const length = Number(response.headers['content-length'] || 0);
    if (!allowedImageTypes.has(type) || (length && length > maxImageBytes)) {
      response.destroy();
      fail(415, 'Unsupported image.');
    }
    const bytes = await readImageBody(response);
    return imageData({ mimetype: type, size: bytes.length, content_base64: bytes.toString('base64') });
  }
  fail(502, 'Image could not be loaded.');
}

async function initialize(ctx) {
  // The schema as the published 0.2.4 left it (its steps 001–014), written so a database already there is left as it is;
  // later changes follow as their own steps, so an install of any published release can still update.
  await ctx.db.migrate('000_schema', `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'private', folder_id TEXT, properties TEXT NOT NULL DEFAULT '[]', icon TEXT);
  CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id, archived, updated_at);
  CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder_id, archived, updated_at);
  CREATE TABLE IF NOT EXISTS note_collaborators (
    note_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (note_id, user_id));
  CREATE INDEX IF NOT EXISTS note_collaborators_user ON note_collaborators(user_id);
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, icon TEXT);
  CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent_id, archived, name);
  CREATE TABLE IF NOT EXISTS folder_collaborators (
    folder_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (folder_id, user_id));
  CREATE INDEX IF NOT EXISTS folder_collaborators_user ON folder_collaborators(user_id);
  CREATE TABLE IF NOT EXISTS trip_folders (
    id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, icon TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS trip_folders_trip ON trip_folders(trip_id, parent_id, archived, name);
  CREATE TABLE IF NOT EXISTS trip_note_folders (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, folder_id TEXT NOT NULL, PRIMARY KEY (trip_id, note_id));
  CREATE INDEX IF NOT EXISTS trip_note_folders_folder ON trip_note_folders(trip_id, folder_id);
  CREATE TABLE IF NOT EXISTS trip_note_links (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source_owner_id INTEGER NOT NULL, linked_by INTEGER,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')), day_id INTEGER, linked_at TEXT NOT NULL, PRIMARY KEY (trip_id, note_id));
  CREATE INDEX IF NOT EXISTS trip_note_links_owner ON trip_note_links(source_owner_id, trip_id);
  CREATE INDEX IF NOT EXISTS trip_note_links_actor ON trip_note_links(linked_by, trip_id);
  CREATE TABLE IF NOT EXISTS trip_note_snapshots (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, visibility TEXT NOT NULL, captured_at TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '[]', icon TEXT, PRIMARY KEY (trip_id, note_id));
  CREATE TABLE IF NOT EXISTS snapshot_assets (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source TEXT NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL,
    content_base64 TEXT NOT NULL, PRIMARY KEY (trip_id, note_id, source));
  CREATE INDEX IF NOT EXISTS snapshot_assets_note ON snapshot_assets(note_id, trip_id);
  CREATE TABLE IF NOT EXISTS trip_note_intents (
    owner_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, trip_folder_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS trip_note_comments (
    id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, parent_id TEXT, author_id INTEGER NOT NULL,
    body TEXT NOT NULL, quote TEXT, prefix TEXT, suffix TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    resolved_at TEXT, resolved_by INTEGER);
  CREATE INDEX IF NOT EXISTS trip_note_comments_note ON trip_note_comments(trip_id, note_id, created_at);
  CREATE INDEX IF NOT EXISTS trip_note_comments_author ON trip_note_comments(author_id);
  CREATE TABLE IF NOT EXISTS note_crdt (note_id TEXT PRIMARY KEY, state TEXT NOT NULL, seq INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS note_updates (
    note_id TEXT NOT NULL, seq INTEGER NOT NULL, client_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (note_id, seq));
  CREATE TABLE IF NOT EXISTS note_presence (
    note_id TEXT NOT NULL, client_id INTEGER NOT NULL, user_id INTEGER NOT NULL, cursor TEXT, seen_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, client_id));
  CREATE TABLE IF NOT EXISTS note_assets (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL, content_base64 TEXT NOT NULL,
    created_at TEXT NOT NULL, released_at TEXT);
  CREATE INDEX IF NOT EXISTS note_assets_owner ON note_assets(owner_id);
  CREATE TABLE IF NOT EXISTS asset_uploads (
    id TEXT NOT NULL, owner_id INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (id, part));
  CREATE INDEX IF NOT EXISTS asset_uploads_created ON asset_uploads(created_at);`);
  await ctx.db.migrate('015_note_versions', `CREATE TABLE note_versions (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, edited_at TEXT NOT NULL, editors TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL, icon TEXT, properties TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL
  ); CREATE INDEX note_versions_note ON note_versions(note_id, edited_at);
  ALTER TABLE notes ADD COLUMN burst_at TEXT;
  ALTER TABLE notes ADD COLUMN edited_by TEXT NOT NULL DEFAULT '[]';`);
  await ctx.db.migrate('016_request_parts', `CREATE TABLE request_parts (
    id TEXT NOT NULL, owner_id INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (id, part)
  ); CREATE INDEX request_parts_created ON request_parts(created_at);`);
  // Snapshots are co-edited and versioned as notes are, keyed `trip:<trip id>:<note id>` in the same tables.
  await ctx.db.migrate('017_snapshot_history', `ALTER TABLE trip_note_snapshots ADD COLUMN burst_at TEXT;
  ALTER TABLE trip_note_snapshots ADD COLUMN edited_by TEXT NOT NULL DEFAULT '[]';`);
  // Deleted notes drop their co-editing log at once and are deleted permanently after 30 days; versions carry their size in
  // bytes; folder changes bump a generation the folder cache keys on.
  await ctx.db.migrate('018_storage_upkeep', `ALTER TABLE notes ADD COLUMN archived_at TEXT;
  UPDATE notes SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE archived = 1;
  DELETE FROM note_presence WHERE note_id IN (SELECT id FROM notes WHERE archived = 1);
  DELETE FROM note_updates WHERE note_id IN (SELECT id FROM notes WHERE archived = 1);
  DELETE FROM note_crdt WHERE note_id IN (SELECT id FROM notes WHERE archived = 1);
  ALTER TABLE note_versions ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
  UPDATE note_versions SET bytes = ${VERSION_BYTES};
  CREATE INDEX note_versions_age ON note_versions(edited_at, id, bytes);
  CREATE INDEX notes_live ON notes(archived, updated_at DESC, id);
  CREATE INDEX trip_note_links_note ON trip_note_links(note_id, trip_id);
  CREATE INDEX trip_note_comments_parent ON trip_note_comments(parent_id);
  CREATE INDEX request_parts_owner ON request_parts(owner_id);
  DROP INDEX IF EXISTS trip_note_snapshots_captured;
  CREATE TABLE plugin_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO plugin_state (key, value) VALUES ('folders', lower(hex(randomblob(16))));`);
  // Removing a note from a trip marks its link; the trip's Recently deleted lists the marked ones until they are recovered or go.
  await ctx.db.migrate('019_trip_recently_deleted', `ALTER TABLE trip_note_links ADD COLUMN removed_at TEXT;
  ALTER TABLE trip_note_links ADD COLUMN removed_by INTEGER;
  CREATE INDEX trip_note_links_removed ON trip_note_links(removed_at);`);
}

const roleValue = (role) => {
  if (role === 'editor') return 2;
  if (role === 'viewer') return 1;
  return 0;
};
const roleName = (value) => {
  if (value >= 2) return 'editor';
  if (value === 1) return 'viewer';
  return null;
};

function folderAccessFromRows(userId, folderId, folders, collaborators) {
  let currentId = folderId;
  const chain = [];
  const seen = new Set();
  while (currentId) {
    if (seen.has(currentId) || chain.length > 64) fail(409, 'Folder hierarchy is cyclic.');
    seen.add(currentId);
    const folder = folders.get(currentId);
    if (!folder) return null;
    chain.push(folder); currentId = folder.parent_id;
  }
  let role = 0;
  for (const folder of chain) role = Math.max(role, folder.owner_id === userId ? 2 : roleValue(collaborators.get(folder.id)));
  const explicitRole = role;
  const publicPath = chain.every((folder) => folder.visibility === 'public');
  const publicGrant = publicPath && explicitRole === 0;
  if (publicGrant) role = 1;
  return { folder: chain[0], chain, role: roleName(role), publicPath, publicGrant };
}

// Access checks walk folder chains on nearly every request, and this database cannot walk them itself (RECURSIVE is refused),
// so the folder tree is read once and kept until it changes: every write to `folders` also stamps a new generation, and a
// one-row read of that stamp decides whether the copy here is still current.
const FOLDERS_CHANGED = { sql: "UPDATE plugin_state SET value = lower(hex(randomblob(16))) WHERE key = 'folders'" };
let folderCache = { generation: null, folders: new Map() };
async function folderTree(ctx) {
  const [stamp] = await ctx.db.query("SELECT value FROM plugin_state WHERE key = 'folders'");
  if (stamp && stamp.value === folderCache.generation) return folderCache.folders;
  const rows = await ctx.db.query(
    'SELECT id, owner_id, parent_id, name, icon, visibility, created_at, updated_at, archived FROM folders WHERE archived = 0');
  folderCache = { generation: stamp?.value ?? null, folders: new Map(rows.map((folder) => [folder.id, folder])) };
  return folderCache.folders;
}
const writeFolders = (ctx, sql, ...args) => ctx.db.tx([{ sql, args }, FOLDERS_CHANGED]);

// `folders` reuses a tree already read for this request.
async function listAccessData(ctx, userId, includeNoteCollaborators = true, folders = null) {
  const [tree, folderCollaboratorRows, noteCollaboratorRows] = await Promise.all([
    folders || folderTree(ctx),
    ctx.db.query('SELECT folder_id, role FROM folder_collaborators WHERE user_id = ?', userId),
    includeNoteCollaborators ? ctx.db.query('SELECT note_id, role FROM note_collaborators WHERE user_id = ?', userId) : [],
  ]);
  return {
    folders: tree,
    folderCollaborators: new Map(folderCollaboratorRows.map((row) => [row.folder_id, row.role])),
    noteCollaborators: new Map(noteCollaboratorRows.map((row) => [row.note_id, row.role])),
  };
}

function noteAccessFromRows(userId, row, access) {
  const directRole = access.noteCollaborators.get(row.id) || null;
  const folder = row.folder_id ? folderAccessFromRows(userId, row.folder_id, access.folders, access.folderCollaborators) : null;
  const inheritedRole = folder?.publicGrant && row.visibility !== 'public' ? 0 : roleValue(folder?.role);
  const publicReadable = row.visibility === 'public' && (!folder || folder.publicPath);
  const canRead = row.owner_id === userId || Boolean(directRole) || inheritedRole > 0 || publicReadable;
  return { folder, directRole, inheritedRole,
    role: Math.max(roleValue(directRole), inheritedRole, row.owner_id === userId ? 2 : 0), canRead, publicReadable };
}

// Single checks reuse the bulk rules, so who may read or edit is defined exactly once.
async function folderAccess(ctx, userId, folderId) {
  const access = await listAccessData(ctx, userId, false);
  return folderAccessFromRows(userId, id(folderId), access.folders, access.folderCollaborators);
}

async function folderForWrite(ctx, userId, folderId) {
  if (folderId === null || folderId === undefined || folderId === '') return null;
  const access = await folderAccess(ctx, userId, folderId);
  if (!access) fail(404, 'Folder not found.');
  if (roleValue(access.role) < 2) fail(403, 'Folder edit permission required.');
  return access.folder;
}

async function noteAccess(ctx, userId, row) {
  return noteAccessFromRows(userId, row, await listAccessData(ctx, userId));
}

async function owned(ctx, userId, noteId) {
  const [row] = await ctx.db.query('SELECT * FROM notes WHERE id = ? AND owner_id = ? AND archived = 0', id(noteId), userId);
  if (!row) fail(404, 'Note not found.');
  return { ...decode(row), can_edit: true };
}

async function readable(ctx, userId, noteId) {
  const [row] = await ctx.db.query('SELECT * FROM notes WHERE id = ? AND archived = 0', id(noteId));
  const access = row ? await noteAccess(ctx, userId, row) : null;
  if (!row || !access?.canRead) fail(404, 'Note not found.');
  return { ...decode(row), can_edit: access.role >= 2 };
}

async function editable(ctx, userId, noteId) {
  const note = await readable(ctx, userId, noteId);
  if (!note.can_edit) fail(403, 'Edit permission required.');
  return note;
}

async function checkTrip(ctx, tripId) {
  const trip = await ctx.trips.getById(number(tripId));
  if (!trip) fail(404, 'Trip not found.');
  return trip;
}

async function requireTripEdit(ctx, tripId) {
  // Trip reads check membership only; metadata deletion also applies the host's trip_edit gate.
  await ctx.meta.delete('trip', tripId, `fieldnotes:edit-check:${randomUUID()}`);
}

async function checkDay(ctx, tripId, dayId) {
  if (dayId === null || dayId === undefined || dayId === '') return null;
  const n = number(dayId);
  const days = await ctx.trips.getDays(number(tripId));
  if (!days.some((day) => day.id === n)) fail(400, 'The day does not belong to this trip.');
  return n;
}

// Callers have already checked the trip.
async function tripFolderList(ctx, tripId) {
  const rows = await ctx.db.query(`SELECT id, trip_id, parent_id, name, icon, created_at, updated_at FROM trip_folders
    WHERE trip_id = ? AND archived = 0 ORDER BY parent_id, name, id`, tripId);
  return rows.map((row) => ({ id: row.id, trip_id: row.trip_id, parent_id: row.parent_id, name: row.name, icon: row.icon || null,
    created_at: row.created_at, updated_at: row.updated_at, visibility: 'private', role: 'editor', public_path: true, can_manage: true }));
}

async function tripFolder(ctx, tripId, folderId) {
  const [folder] = await ctx.db.query('SELECT * FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', id(folderId), tripId);
  return folder || fail(404, 'Folder not found.');
}

// Rejects moving a folder into itself or its own subtree, and name clashes at the destination.
async function checkReparent(ctx, table, folder, parentId, scope = {}) {
  const where = Object.keys(scope).map((column) => ` AND ${column} = ?`).join('');
  let current = parentId;
  while (current) {
    if (current === folder.id) fail(409, 'A folder cannot be moved into itself.');
    const [row] = await ctx.db.query(`SELECT parent_id FROM ${table} WHERE id = ?${where}`, current, ...Object.values(scope));
    current = row?.parent_id || null;
  }
  const duplicate = await ctx.db.query(`SELECT id FROM ${table} WHERE id != ? AND archived = 0 AND name = ?${where} AND `
    + '(parent_id = ? OR (parent_id IS NULL AND ? IS NULL))', folder.id, folder.name, ...Object.values(scope), parentId, parentId);
  if (duplicate.length) fail(409, 'A folder with this name already exists here.');
}

async function tripFolderAction(input, ctx, trip) {
  if (input.action === 'folders') return tripFolderList(ctx, trip.id);
  await requireTripEdit(ctx, trip.id);
  const listed = async (folderId) => (await tripFolderList(ctx, trip.id)).find((item) => item.id === folderId);
  if (input.action === 'folder_create') {
    const name = folderName(input.name);
    const parentId = input.parent_id ? (await tripFolder(ctx, trip.id, input.parent_id)).id : null;
    const duplicate = await ctx.db.query(`SELECT id FROM trip_folders WHERE trip_id = ? AND name = ? AND archived = 0
      AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))`, trip.id, name, parentId, parentId);
    if (duplicate.length) fail(409, 'A folder with this name already exists here.');
    const folderId = randomUUID(); const now = new Date().toISOString();
    await ctx.db.exec(`INSERT INTO trip_folders (id, trip_id, parent_id, name, icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, folderId, trip.id, parentId, name, folderIcon(input.icon), now, now);
    return listed(folderId);
  }
  if (input.action === 'folder_move_note') {
    const noteId = id(input.note_id);
    await tripLink(ctx, trip.id, noteId);
    const targetId = input.folder_id ? (await tripFolder(ctx, trip.id, input.folder_id)).id : null;
    if (targetId) {
      await ctx.db.exec('INSERT OR REPLACE INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)',
        trip.id, noteId, targetId);
    } else await ctx.db.exec('DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?', trip.id, noteId);
    return { moved: true, folder_id: targetId };
  }
  const folder = await tripFolder(ctx, trip.id, input.folder_id);
  const now = new Date().toISOString();
  if (input.action === 'folder_move') {
    const parentId = input.parent_id ? (await tripFolder(ctx, trip.id, input.parent_id)).id : null;
    await checkReparent(ctx, 'trip_folders', folder, parentId, { trip_id: trip.id });
    await ctx.db.exec('UPDATE trip_folders SET parent_id = ?, updated_at = ? WHERE id = ?', parentId, now, folder.id);
    return listed(folder.id);
  }
  if (input.action === 'folder_icon') {
    await ctx.db.exec('UPDATE trip_folders SET icon = ?, updated_at = ? WHERE id = ?', folderIcon(input.icon), now, folder.id);
    return listed(folder.id);
  }
  if (input.action === 'folder_archive') {
    const [child] = await ctx.db.query('SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id = ? AND archived = 0 LIMIT 1',
      trip.id, folder.id);
    const [assignment] = await ctx.db.query('SELECT note_id FROM trip_note_folders WHERE trip_id = ? AND folder_id = ? LIMIT 1',
      trip.id, folder.id);
    if (child || assignment) fail(409, 'Move child folders and notes before deleting this folder.');
    await ctx.db.exec('UPDATE trip_folders SET archived = 1, updated_at = ? WHERE id = ?', now, folder.id);
    return { archived: true };
  }
  fail(400, 'Unknown trip folder action.');
}

// With `actorId`, live references also say whether that person may freeze them into a snapshot. Callers have checked the trip.
async function tripNotes(ctx, trip, actorId = null) {
  const links = await ctx.db.query(`SELECT note_id, source_owner_id, mode, day_id, linked_at FROM trip_note_links
    WHERE trip_id = ? AND removed_at IS NULL ORDER BY linked_at, note_id`, trip.id);
  if (!links.length) return { trip, notes: [] };
  const assignments = new Map((await ctx.db.query('SELECT note_id, folder_id FROM trip_note_folders WHERE trip_id = ?', trip.id))
    .map((row) => [row.note_id, row.folder_id]));
  const members = await ctx.trips.members(trip.id);
  const memberIds = new Set([trip.user_id, ...members.map((member) => member.id)]);
  const ids = links.map((link) => link.note_id);
  const [rows, snapshots] = await Promise.all([
    ctx.db.query('SELECT * FROM notes WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)),
    ctx.db.query('SELECT * FROM trip_note_snapshots WHERE trip_id = ?', trip.id),
  ]);
  const access = actorId ? await listAccessData(ctx, actorId) : null;
  const canSnapshot = (row) => Boolean(access && noteAccessFromRows(actorId, row, access).canRead);
  const notesById = new Map(rows.map((row) => [row.id, { ...decode(row), can_snapshot: canSnapshot(row) }]));
  const snapshotsById = new Map(snapshots.map((row) => [row.note_id, decode(row)]));
  const notes = links.map((link) => {
    const noteId = link.note_id;
    const folder_id = assignments.get(noteId) || null;
    if (link.mode === 'snapshot') {
      const snapshot = snapshotsById.get(noteId);
      return snapshot ? { ...snapshot, id: noteId, mode: 'snapshot', day_id: link.day_id, folder_id }
        : { id: noteId, unavailable: true, mode: 'snapshot', day_id: link.day_id, folder_id };
    }
    const note = notesById.get(noteId);
    if (!note || note.archived || (note.visibility !== 'public' && !memberIds.has(note.owner_id))) {
      return { id: noteId, unavailable: true, mode: 'live', day_id: link.day_id, folder_id };
    }
    return { ...note, mode: 'live', day_id: link.day_id, folder_id };
  });
  return { trip, notes };
}

const userNumber = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(400, 'Invalid user identifier.');
  return n;
};

// `none` removes someone; anyone may be removed, but only trip companions may be given a role.
function roleChanges(input) {
  if (!Array.isArray(input.changes) || input.changes.length > 100) fail(400, 'Invalid collaborator changes.');
  const seen = new Set();
  return input.changes.map((change) => {
    const userId = userNumber(change?.user_id);
    if (seen.has(userId) || !['editor', 'viewer', 'none'].includes(change?.role)) fail(400, 'Invalid collaborator changes.');
    seen.add(userId);
    return { userId, role: change.role };
  });
}

// A note or folder (`kind`) keeps who it is shared with in `<kind>_collaborators`; only its owner calls these.
async function roster(ctx, userId, kind, targetId) {
  const rows = await ctx.db.query(`SELECT user_id, role, created_at FROM ${kind}_collaborators WHERE ${kind}_id = ?
    ORDER BY created_at, user_id`, targetId);
  const candidates = await collaborationCandidates(ctx, userId);
  return { collaborators: rows.map((row) => ({ ...row, user: candidates.get(row.user_id) || { id: row.user_id } })),
    candidates: [...candidates.values()] };
}

async function saveRoles(ctx, userId, kind, targetId, input) {
  const changes = roleChanges(input);
  const candidates = await collaborationCandidates(ctx, userId);
  for (const change of changes) {
    if (change.userId === userId) {
      fail(400, kind === 'note' ? 'The note owner is always an editor.' : 'The folder owner is always an editor.');
    }
    if (change.role !== 'none' && !candidates.has(change.userId)) fail(403, 'This user is not available for collaboration.');
  }
  const now = new Date().toISOString();
  await ctx.db.tx(changes.map((change) => change.role === 'none'
    ? { sql: `DELETE FROM ${kind}_collaborators WHERE ${kind}_id = ? AND user_id = ?`, args: [targetId, change.userId] }
    : { sql: `INSERT INTO ${kind}_collaborators (${kind}_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(${kind}_id, user_id) DO UPDATE SET role = excluded.role`, args: [targetId, change.userId, change.role, now] }));
  return changes;
}

async function listFolders(ctx, userId) {
  const access = await listAccessData(ctx, userId, false);
  return [...access.folders.values()]
    .sort((a, b) => String(a.parent_id || '').localeCompare(String(b.parent_id || '')) || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id))
    .flatMap((row) => {
      const rights = folderAccessFromRows(userId, row.id, access.folders, access.folderCollaborators);
      if (!rights?.role) return [];
      return [{ id: row.id, owner_id: row.owner_id, parent_id: row.parent_id, name: row.name,
        icon: row.icon || null, visibility: row.visibility, role: rights.role, created_at: row.created_at, updated_at: row.updated_at,
        public_path: rights.publicPath, can_manage: row.owner_id === userId }];
    });
}

async function folderAction(input, ctx, userId) {
  const listed = async (folderId) => (await listFolders(ctx, userId)).find((item) => item.id === folderId);
  if (input.action === 'create') {
    const name = folderName(input.name);
    if (!['private', 'public'].includes(input.visibility || 'private')) fail(400, 'Invalid folder visibility.');
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) await folderForWrite(ctx, userId, parentId);
    // Root folders only clash with the owner's own, so a name check never reveals another user's private folders.
    const duplicate = await ctx.db.query(`SELECT id FROM folders WHERE name = ? AND archived = 0
      AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL AND owner_id = ?))`, name, parentId, parentId, userId);
    if (duplicate.length) fail(409, 'A folder with this name already exists here.');
    const folderId = randomUUID(); const now = new Date().toISOString();
    await writeFolders(ctx, `INSERT INTO folders (id, owner_id, parent_id, name, icon, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, folderId, userId, parentId, name, folderIcon(input.icon), input.visibility || 'private', now, now);
    return listed(folderId);
  }
  if (input.action === 'move_note') {
    const noteId = id(input.note_id);
    // Moving re-scopes folder inheritance, which is sharing control, so it stays with the owner like visibility.
    if ((await editable(ctx, userId, noteId)).owner_id !== userId) fail(403, 'Only the owner can move a note.');
    const target = await folderForWrite(ctx, userId, input.folder_id);
    await ctx.db.exec('UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ?', target?.id || null, new Date().toISOString(), noteId);
    return readable(ctx, userId, noteId);
  }
  const folderId = id(input.folder_id);
  const [folder] = await ctx.db.query('SELECT * FROM folders WHERE id = ? AND archived = 0', folderId);
  if (!folder || folder.owner_id !== userId) fail(404, 'Folder not found.');
  const now = new Date().toISOString();
  if (input.action === 'move') {
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) await folderForWrite(ctx, userId, parentId);
    await checkReparent(ctx, 'folders', folder, parentId, parentId ? {} : { owner_id: userId });
    await writeFolders(ctx, 'UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?', parentId, now, folderId);
    return listed(folderId);
  }
  if (input.action === 'visibility') {
    if (!['private', 'public'].includes(input.visibility)) fail(400, 'Invalid folder visibility.');
    await writeFolders(ctx, 'UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ?', input.visibility, now, folderId);
    return listed(folderId);
  }
  if (input.action === 'icon') {
    await writeFolders(ctx, 'UPDATE folders SET icon = ?, updated_at = ? WHERE id = ?', folderIcon(input.icon), now, folderId);
    return listed(folderId);
  }
  if (input.action === 'archive') {
    const [child] = await ctx.db.query('SELECT id FROM folders WHERE parent_id = ? AND archived = 0 LIMIT 1', folderId);
    const [note] = await ctx.db.query('SELECT id FROM notes WHERE folder_id = ? AND archived = 0 LIMIT 1', folderId);
    if (child || note) fail(409, 'Move child folders and notes before deleting this folder.');
    await writeFolders(ctx, 'UPDATE folders SET archived = 1, updated_at = ? WHERE id = ?', now, folderId);
    return { archived: true };
  }
  if (input.action === 'collaborators') return roster(ctx, userId, 'folder', folderId);
  if (input.action === 'bulk_roles') return { saved: (await saveRoles(ctx, userId, 'folder', folderId, input)).length };
  fail(400, 'Unknown folder action.');
}

async function collaborationCandidates(ctx, userId) {
  const candidates = new Map();
  for (const trip of await ctx.trips.listMine()) {
    for (const member of await ctx.trips.members(Number(trip.id))) {
      if (member.id !== userId) candidates.set(member.id, member);
    }
  }
  return candidates;
}

async function collaborators(ctx, userId, noteId) {
  const note = await owned(ctx, userId, noteId);
  return roster(ctx, userId, 'note', note.id);
}

async function collaboratorAction(input, ctx, userId) {
  const note = await owned(ctx, userId, input.note_id);
  if (input.action !== 'bulk_roles') fail(400, 'Unknown action.');
  const changes = await saveRoles(ctx, userId, 'note', note.id, input);
  // A removed person's open editing session must not keep writing.
  if (changes.some((change) => change.role === 'none')) collab.forget(note.id);
  return { saved: changes.length };
}

// With `versionId` the image belongs to a kept version, which only the note's editors may read.
// The images the note (or the earlier version of it) shows, as only those may be read through it.
async function shownImages(ctx, userId, noteId, tripId, versionId) {
  if (versionId) {
    const version = tripId === null ? await history.read(ctx, userId, noteId, versionId)
      : await snapshotHistory.read(ctx, userId, snapshotKey(tripId, id(noteId)), versionId);
    return new Set(imageSources(version.content));
  }
  const note = tripId === null ? await readable(ctx, userId, noteId)
    : (await tripNotes(ctx, await checkTrip(ctx, tripId))).notes.find((item) => item.id === id(noteId) && !item.unavailable);
  if (!note) fail(404, 'Image not found.');
  return new Set(imageSources(note.content));
}
const assetTrip = (input) => input.trip_id === undefined || input.trip_id === null || input.trip_id === '' ? null : number(input.trip_id);

async function asset(ctx, userId, input) {
  const noteId = id(input.note_id);
  const source = text(input.source, 2048, 'image source');
  const tripId = assetTrip(input);
  if (!(await shownImages(ctx, userId, noteId, tripId, input.version_id)).has(source)) fail(404, 'Image not found.');
  if (tripId !== null) {
    const [snapshot] = await ctx.db.query(`SELECT mimetype, size, content_base64 FROM snapshot_assets
      WHERE trip_id = ? AND note_id = ? AND source = ?`, tripId, noteId, source);
    if (snapshot) return { source, ...imageData(snapshot) };
  }
  const uploaded = await uploads.read(ctx, source);
  if (uploaded) return { source, ...imageData(uploaded, 'uploaded image') };
  if (/^https:\/\//i.test(source)) return { source, ...await fetchExternalImage(source) };
  fail(400, 'Unsupported image source.');
}

// Up to `assetBatch` of a note's images per request, behind one access check and one read: TREK caps how often a plugin may call
// it, and a note full of images fetched one by one would run past that cap. A failed image comes back as its error; once a response
// holds ASSET_BATCH_CHARS of data the rest is left for the next request.
const ASSET_BATCH_CHARS = 4 * 1024 * 1024;
async function assets(ctx, userId, input) {
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > assetBatch) {
    fail(400, 'Invalid value: {field}.', { field: 'image source' });
  }
  const sources = [...new Set(input.sources.map((source) => text(source, 2048, 'image source')))];
  const noteId = id(input.note_id); const tripId = assetTrip(input);
  const shown = await shownImages(ctx, userId, noteId, tripId, input.version_id);
  const kept = tripId === null ? [] : await ctx.db.query(`SELECT source, mimetype, size, content_base64 FROM snapshot_assets
    WHERE trip_id = ? AND note_id = ? AND source IN (SELECT value FROM json_each(?))`, tripId, noteId, JSON.stringify(sources));
  const snapshots = new Map(kept.map((row) => [row.source, row]));
  const uploaded = await uploads.readMany(ctx, sources.filter((source) => shown.has(source) && !snapshots.has(source)));
  const images = []; let chars = 0;
  for (const [index, source] of sources.entries()) {
    if (images.length && chars >= ASSET_BATCH_CHARS) return { images, rest: sources.slice(index) };
    try {
      if (!shown.has(source)) fail(404, 'Image not found.');
      const image = snapshots.has(source) ? imageData(snapshots.get(source))
        : uploaded.has(source) ? imageData(uploaded.get(source), 'uploaded image')
          : uploads.isUpload(source) ? fail(404, 'This file was deleted.')
            : /^https:\/\//i.test(source) ? await fetchExternalImage(source) : fail(400, 'Unsupported image source.');
      images.push({ source, data_url: image.data_url }); chars += image.data_url.length;
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      images.push({ source, error: error.message, status: error.status, template: error.template, params: error.params });
    }
  }
  return { images, rest: [] };
}

// `keptBytes` counts the copies a snapshot already holds, so an edit cannot grow it past the same cap. A trip's own files are
// copied only into a snapshot of that trip (`tripId`); a library note never reaches them.
async function captureSnapshotAssets(ctx, sources, keptBytes = 0, tripId = null) {
  if (sources.length > maxSnapshotAssets) fail(400, 'A snapshot can include at most {count} images.', { count: maxSnapshotAssets });
  const assets = []; let totalBytes = keptBytes;
  for (const source of sources) {
    const file = tripFileSource(source);
    if (file && file.tripId !== tripId) continue;
    let image;
    try {
      let content = file ? await ctx.files.getContent(file.tripId, file.fileId) : await uploads.read(ctx, source);
      if (!content && /^https:\/\//i.test(source)) content = await fetchExternalImage(source);
      if (!content) continue;
      image = imageData(content, file ? 'trip file' : 'image');
    } catch (error) {
      // An image that cannot be fetched must not block freezing the note; readers of the snapshot are told why it is missing.
      if (error instanceof Problem) continue;
      throw error;
    }
    totalBytes += image.size;
    if (totalBytes > maxSnapshotAssetsBytes) {
      fail(400, 'Snapshot images exceed the {size} MB limit.', { size: maxSnapshotAssetsBytes / 1024 / 1024 });
    }
    assets.push({ source, ...image });
  }
  return assets;
}

// Writes that freeze a note into a trip as its snapshot, with the image copies `captureSnapshotAssets` made.
const freezeOps = (tripId, note, assets, capturedAt) => [
  { sql: `INSERT INTO trip_note_snapshots (trip_id, note_id, title, content, tags, properties, icon, version, updated_at, visibility,
    captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [tripId, note.id, note.title, note.content, JSON.stringify(note.tags),
    JSON.stringify(note.properties), note.icon ?? null, note.version, note.updated_at, note.visibility, capturedAt] },
  ...copyOps(tripId, note.id, assets)];
// A snapshot's image copies; with `guard` (SQL and its args) each is written only while the guard holds.
const copyOps = (tripId, noteId, assets, guard = null) => assets.map((copy) => ({
  sql: `INSERT OR REPLACE INTO snapshot_assets (trip_id, note_id, source, mimetype, size, content_base64)
    SELECT ?, ?, ?, ?, ?, ?${guard ? ` WHERE ${guard.sql}` : ''}`,
  args: [tripId, noteId, copy.source, copy.mimetype, copy.size, copy.content_base64, ...(guard?.args || [])] }));
// Runs writes too many for one transaction in as many as they need.
async function inBatches(ctx, ops) {
  for (let at = 0; at < ops.length; at += TX_CAP) await ctx.db.tx(ops.slice(at, at + TX_CAP));
}

// The page a trip opens to write a new note takes the trip it came from, if it asks within ten minutes.
const INTENT_TTL_MS = 10 * 60 * 1000;
async function beginTripNote(ctx, trip, actorId, input) {
  await requireTripEdit(ctx, trip.id);
  const ownerId = await tripActor(ctx, trip, actorId);
  const tripFolderId = input.trip_folder_id ? (await tripFolder(ctx, trip.id, input.trip_folder_id)).id : null;
  await ctx.db.exec(`INSERT OR REPLACE INTO trip_note_intents (owner_id, trip_id, trip_folder_id, created_at)
    VALUES (?, ?, ?, ?)`, ownerId, trip.id, tripFolderId, new Date().toISOString());
  return { staged: true };
}

async function takeTripNoteIntent(ctx, userId) {
  const [intent] = await ctx.db.query('SELECT trip_id, trip_folder_id, created_at FROM trip_note_intents WHERE owner_id = ?', userId);
  if (!intent) return null;
  await ctx.db.exec('DELETE FROM trip_note_intents WHERE owner_id = ?', userId);
  if (Date.now() - Date.parse(intent.created_at) > INTENT_TTL_MS) return null;
  try {
    const trip = await checkTrip(ctx, intent.trip_id);
    await requireTripEdit(ctx, trip.id);
    return { tripId: trip.id, tripFolderId: intent.trip_folder_id || null, title: trip.title };
  } catch (error) {
    if (error instanceof Problem && [403, 404].includes(error.status)) return null;
    throw error;
  }
}

async function createTripNote(ctx, userId, input) {
  const trip = await checkTrip(ctx, input.trip_id);
  await requireTripEdit(ctx, trip.id);
  const { title, content, tags } = noteFields(input);
  const properties = input.properties === undefined ? '[]' : propertyFields(input.properties);
  const icon = noteIcon(input.icon);
  const libraryFolderId = input.library_folder_id ? id(input.library_folder_id) : null;
  if (libraryFolderId) await folderForWrite(ctx, userId, libraryFolderId);
  const tripFolderId = input.trip_folder_id ? (await tripFolder(ctx, trip.id, input.trip_folder_id)).id : null;
  const noteId = randomUUID(); const now = new Date().toISOString();
  const ops = [
    { sql: `INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at, updated_at,
      burst_at, edited_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, json_array(?))`,
    args: [noteId, userId, title, content, tags ?? '[]', properties, icon, libraryFolderId, now, now, now, userId] },
    { sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
      VALUES (?, ?, ?, ?, 'live', NULL, ?)`, args: [trip.id, noteId, userId, userId, now] },
  ];
  if (tripFolderId) {
    ops.push({ sql: 'INSERT INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)',
      args: [trip.id, noteId, tripFolderId] });
  }
  await ctx.db.tx([...ops, ...uploads.referenceOps('', content)]);
  return owned(ctx, userId, noteId);
}

async function createTripLink(ctx, userId, input) {
  const note = await readable(ctx, userId, input.note_id);
  const trip = await checkTrip(ctx, input.trip_id);
  const dayId = await checkDay(ctx, trip.id, input.day_id);
  if (!['live', 'snapshot'].includes(input.mode)) fail(400, 'Choose live reference or snapshot.');
  // A live reference keeps following the note, so collaborators may only share what is already public; a snapshot is a copy.
  if (input.mode === 'live' && note.owner_id !== userId && !(await noteAccess(ctx, userId, note)).publicReadable)
    fail(403, 'Only the owner can share a private note live. Import a snapshot instead.');
  await requireTripEdit(ctx, trip.id);
  const [existing] = await ctx.db.query('SELECT removed_at FROM trip_note_links WHERE trip_id = ? AND note_id = ?', trip.id, note.id);
  if (existing?.removed_at) fail(409, 'This note is in the trip’s Recently deleted. Recover it there, or delete it permanently first.');
  if (existing) fail(409, 'Already linked. Remove the existing link before replacing it.');
  const linkedAt = new Date().toISOString();
  const ops = [{ sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [trip.id, note.id, note.owner_id, userId, input.mode, dayId, linkedAt] }];
  if (input.mode === 'snapshot') {
    ops.push(...freezeOps(trip.id, note, await captureSnapshotAssets(ctx, imageSources(note.content)), linkedAt));
  }
  try { await ctx.db.tx(ops); }
  catch (error) {
    if (/UNIQUE constraint failed: trip_note_links\.trip_id, trip_note_links\.note_id/.test(error.message)) {
      fail(409, 'Already linked. Remove the existing link before replacing it.');
    }
    throw error;
  }
  return { linked: true };
}

// The companion route stamps `actor_id` from its own authenticated request, and Fieldnotes' route from its session; either
// way the person must belong to the trip the acting user opened.
async function tripActor(ctx, trip, actorId) {
  const userId = Number(actorId);
  if (!Number.isSafeInteger(userId) || userId < 1) fail(401, 'Sign in first.');
  const members = await ctx.trips.members(trip.id);
  if (Number(trip.user_id) !== userId && !members.some((member) => Number(member.id) === userId)) fail(403, 'Trip member not found.');
  return userId;
}

async function tripLink(ctx, tripId, noteId) {
  const [link] = await ctx.db.query('SELECT * FROM trip_note_links WHERE trip_id = ? AND note_id = ? AND removed_at IS NULL',
    tripId, noteId);
  return link || fail(404, 'Linked note not found.');
}

async function tripNote(ctx, trip, noteId, actorId) {
  const note = (await tripNotes(ctx, trip, actorId)).notes.find((item) => item.id === noteId);
  return note || fail(404, 'Linked note not found.');
}

// Edits keep a snapshot self-contained: images it gains are copied in, and copies neither it nor its versions show go when an
// editor next joins it. The version history keeps what a save replaces (always, with `force`), and open sessions receive it.
async function saveSnapshot(ctx, trip, input, actorId, { force = false } = {}) {
  await requireTripEdit(ctx, trip.id);
  const noteId = id(input.note_id);
  await tripLink(ctx, trip.id, noteId);
  const [current] = await ctx.db.query('SELECT * FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ?', trip.id, noteId);
  if (!current) fail(404, 'Snapshot not found.');
  if (input.version !== current.version) fail(409, 'This note changed. Reload before saving.');
  const { title, content } = noteFields(input);
  const properties = input.properties === undefined ? null : propertyFields(input.properties);
  const icon = input.icon === undefined ? undefined : noteIcon(input.icon);
  const sources = imageSources(content);
  if (sources.length > maxSnapshotAssets) fail(400, 'A snapshot can include at most {count} images.', { count: maxSnapshotAssets });
  const stored = await ctx.db.query('SELECT source, size FROM snapshot_assets WHERE trip_id = ? AND note_id = ?', trip.id, noteId);
  const kept = stored.filter((row) => sources.includes(row.source));
  const keptSources = new Set(kept.map((row) => row.source));
  const added = await captureSnapshotAssets(ctx, sources.filter((source) => !keptSources.has(source)),
    kept.reduce((total, row) => total + row.size, 0), trip.id);
  // Every write is guarded by the version read above, so a concurrent save leaves this one without effect.
  const guard = { sql: 'EXISTS (SELECT 1 FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ? AND version = ?)',
    args: [trip.id, noteId, current.version] };
  const now = new Date().toISOString(); const key = snapshotKey(trip.id, noteId);
  const copies = copyOps(trip.id, noteId, added, guard);
  const writes = [...snapshotHistory.beforeWrite(key, actorId, { force, version: current.version }),
    { sql: `UPDATE trip_note_snapshots SET title = ?, content = ?, properties = COALESCE(?, properties),
      icon = CASE WHEN ? THEN ? ELSE icon END, version = version + 1, updated_at = ?
      WHERE trip_id = ? AND note_id = ? AND version = ?`,
    args: [title, content, properties, icon !== undefined ? 1 : 0, icon ?? null, now, ...guard.args] }];
  // Copies too many to share the save's transaction go ahead in transactions of their own, under the same guard.
  if (copies.length + writes.length > TX_CAP) await inBatches(ctx, copies.splice(0));
  await ctx.db.tx([...copies, ...writes]);
  const saved = await tripNote(ctx, trip, noteId, actorId);
  if (saved.updated_at !== now) fail(409, 'This note changed. Reload before saving.');
  await snapshotCollab.external(ctx, { ...saved, id: key });
  return saved;
}

// Puts an earlier version of a snapshot back as a new change, after keeping the current text as a version of its own.
async function restoreSnapshot(ctx, actorId, key, input) {
  const version = await snapshotHistory.read(ctx, actorId, key, input.version_id);
  const { tripId, noteId } = snapshotParts(key);
  return saveSnapshot(ctx, await checkTrip(ctx, tripId), { note_id: noteId, version: input.version, title: version.title,
    content: version.content, properties: version.properties, icon: version.icon }, actorId, { force: true });
}

// Freezing follows the rule for importing a snapshot: only someone who can read the note in Fieldnotes may keep a copy,
// so a live reference to someone else's private note still lapses when its author leaves.
async function convertToSnapshot(ctx, trip, input, actorId) {
  await requireTripEdit(ctx, trip.id);
  const noteId = id(input.note_id);
  const link = await tripLink(ctx, trip.id, noteId);
  if (link.mode !== 'live') fail(409, 'This note is already a snapshot.');
  const note = await readable(ctx, actorId, noteId).catch((error) => {
    if (error instanceof Problem && error.status === 404)
      fail(403, 'Only people who can read this note in Fieldnotes can turn it into a snapshot.');
    throw error;
  });
  const assets = await captureSnapshotAssets(ctx, imageSources(note.content));
  await ctx.db.tx([
    ...freezeOps(trip.id, note, assets, new Date().toISOString()),
    { sql: "UPDATE trip_note_links SET mode = 'snapshot' WHERE trip_id = ? AND note_id = ? AND mode = 'live' AND removed_at IS NULL",
      args: [trip.id, note.id] },
  ]).catch((error) => {
    if (/UNIQUE constraint failed: trip_note_snapshots/.test(error.message)) fail(409, 'This note is already a snapshot.');
    throw error;
  });
  return tripNote(ctx, trip, noteId, actorId);
}

const commentBody = (value) => {
  const body = text(value, maxCommentChars, 'comment').trim();
  return body || fail(400, 'A comment cannot be empty.');
};

// A thread may quote the passage it is about; the few characters around the quote tell repeated passages apart.
const commentAnchor = (input) => {
  if (input.quote === undefined || input.quote === null || input.quote === '') return [null, null, null];
  const quote = text(input.quote, maxQuoteChars, 'quote').trim();
  const context = (value) => text(value ?? '', quoteContextChars, 'quote context');
  return quote ? [quote, context(input.prefix), context(input.suffix)] : [null, null, null];
};

async function tripComments(ctx, trip, noteId) {
  const rows = await ctx.db.query(`SELECT id, parent_id, author_id, body, quote, prefix, suffix, created_at, updated_at, resolved_at,
    resolved_by FROM trip_note_comments WHERE trip_id = ? AND note_id = ? ORDER BY created_at, rowid`, trip.id, noteId);
  const people = new Map((await ctx.trips.members(trip.id)).map((member) => [Number(member.id), member]));
  // Authors who left the trip keep their name on what they wrote.
  for (const authorId of new Set(rows.map((row) => row.author_id))) {
    if (!people.has(authorId)) people.set(authorId, await ctx.users.getById(authorId) || { id: authorId });
  }
  return rows.map((row) => ({ ...row, author: { ...people.get(row.author_id), color: personColor(row.author_id) } }));
}

// Every trip member may read, write and resolve threads; editing stays with the author, and removal with the author or
// anyone who can edit the trip.
async function commentAction(input, ctx, trip, actorId) {
  const noteId = id(input.note_id);
  await tripLink(ctx, trip.id, noteId);
  if (input.action === 'comments') return tripComments(ctx, trip, noteId);
  const now = new Date().toISOString();
  if (input.action === 'comment_add') {
    const body = commentBody(input.body);
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) {
      const [parent] = await ctx.db.query(`SELECT id FROM trip_note_comments
        WHERE id = ? AND trip_id = ? AND note_id = ? AND parent_id IS NULL`, parentId, trip.id, noteId);
      if (!parent) fail(404, 'Comment not found.');
    }
    const [{ count }] = await ctx.db.query('SELECT COUNT(*) AS count FROM trip_note_comments WHERE trip_id = ? AND note_id = ?',
      trip.id, noteId);
    if (count >= maxCommentsPerNote) fail(400, 'A note can hold at most {count} comments.', { count: maxCommentsPerNote });
    const [quote, prefix, suffix] = parentId ? [null, null, null] : commentAnchor(input);
    await ctx.db.exec(`INSERT INTO trip_note_comments (id, trip_id, note_id, parent_id, author_id, body, quote, prefix, suffix,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), trip.id, noteId, parentId, actorId, body, quote, prefix, suffix, now, now);
    return tripComments(ctx, trip, noteId);
  }
  const [comment] = await ctx.db.query('SELECT * FROM trip_note_comments WHERE id = ? AND trip_id = ? AND note_id = ?',
    id(input.comment_id), trip.id, noteId);
  if (!comment) fail(404, 'Comment not found.');
  if (input.action === 'comment_edit') {
    if (comment.author_id !== actorId) fail(403, 'Only the author can edit a comment.');
    await ctx.db.exec('UPDATE trip_note_comments SET body = ?, updated_at = ? WHERE id = ?', commentBody(input.body), now, comment.id);
  } else if (input.action === 'comment_delete') {
    if (comment.author_id !== actorId) await requireTripEdit(ctx, trip.id);
    await ctx.db.exec('DELETE FROM trip_note_comments WHERE id = ? OR parent_id = ?', comment.id, comment.id);
  } else if (input.action === 'comment_resolve') {
    if (comment.parent_id) fail(400, 'Only a whole thread can be resolved.');
    const resolved = input.resolved === true;
    await ctx.db.exec('UPDATE trip_note_comments SET resolved_at = ?, resolved_by = ? WHERE id = ?',
      resolved ? now : null, resolved ? actorId : null, comment.id);
  } else fail(400, 'Unknown action.');
  return tripComments(ctx, trip, noteId);
}

async function tripAction(raw, ctx, authenticatedUserId = null) {
  // A large body from a trip page comes in parts too; the companion's stamp of who sent it always wins over the parts' own.
  const sender = authenticatedUserId ?? raw.actor_id;
  if (raw.action === 'part' || raw.parts_id) {
    const owner = Number(sender);
    if (!Number.isSafeInteger(owner) || owner < 1) fail(401, 'Sign in first.');
    if (raw.action === 'part') return parts.store(ctx, owner, raw);
  }
  const input = raw.parts_id ? { ...await parts.expand(ctx, Number(sender), raw), actor_id: raw.actor_id } : raw;
  if (input.action === 'links') {
    if (!Number.isSafeInteger(authenticatedUserId) || authenticatedUserId < 1) fail(401, 'Sign in first.');
    const noteId = id(input.note_id);
    await owned(ctx, authenticatedUserId, noteId);
    const accessibleTrips = await ctx.trips.listMine();
    const tripById = new Map(accessibleTrips.map((trip) => [Number(trip.id), trip]));
    const links = await ctx.db.query(
      'SELECT trip_id, mode, day_id FROM trip_note_links WHERE note_id = ? AND removed_at IS NULL ORDER BY trip_id', noteId);
    return links.flatMap((link) => {
      const trip = tripById.get(link.trip_id);
      return trip ? [{ id: link.trip_id, title: trip.title, mode: link.mode, day_id: link.day_id }] : [];
    });
  }
  const tripId = number(input.trip_id);
  if (['collab', 'snapshot_history', 'snapshot_version', 'snapshot_restore'].includes(input.action)) {
    // Every check runs inside the snapshot's own `editable`, which co-editing caches, so a sync costs no extra trip lookups.
    const actorId = Number(sender);
    if (!Number.isSafeInteger(actorId) || actorId < 1) fail(401, 'Sign in first.');
    const key = snapshotKey(tripId, id(input.note_id));
    if (input.action === 'collab') return snapshotCollab.action({ ...input, action: input.op, note_id: key }, ctx, actorId);
    if (input.action === 'snapshot_history') return snapshotHistory.list(ctx, actorId, key);
    if (input.action === 'snapshot_version') return snapshotHistory.read(ctx, actorId, key, input.version_id);
    return restoreSnapshot(ctx, actorId, key, input);
  }
  // An image of an earlier version is for the people who may read that history, so it is the one trip read that names its reader.
  if (input.action === 'asset') return asset(ctx, input.version_id ? Number(sender) : null, input);
  if (input.action === 'assets') return assets(ctx, input.version_id ? Number(sender) : null, input);
  const trip = await checkTrip(ctx, tripId);
  if (['folders', 'folder_create', 'folder_icon', 'folder_archive', 'folder_move', 'folder_move_note'].includes(input.action)) {
    return tripFolderAction(input, ctx, trip);
  }
  if (input.action === 'list') {
    const listed = await tripNotes(ctx, trip, sender ? await tripActor(ctx, trip, sender) : null);
    const search = text(input.q || '', 120, 'search');
    if (!search) return listed;
    // On a trip page search covers the notes shared with it, best matches first; ones the reader cannot open never match.
    const found = listed.notes.flatMap((note) => {
      const match = !note.unavailable && rank(search, note, propertyText(note.properties || []));
      return match ? [{ ...note, snippet: match.snippet, score: match.score }] : [];
    });
    return { ...listed, notes: found.sort((a, b) => b.score - a.score).map(({ score: _score, ...note }) => note) };
  }
  if (input.action === 'begin_note') return beginTripNote(ctx, trip, sender, input);
  if (input.action === 'days') return ctx.trips.getDays(tripId);
  // Links on a trip page resolve, suggest and point back among the notes shared with that trip.
  if (input.action === 'reference') return resolveReference(ctx, null, input.ref, trip, input.embed === true);
  if (input.action === 'link_targets') {
    return linkTargets(ctx, null, { q: input.q, exclude: input.exclude, trip, headings: input.headings === true });
  }
  if (input.action === 'backlinks') return backlinks(ctx, null, input.note_id, trip);
  if (input.action === 'can_edit') { await requireTripEdit(ctx, tripId); return { can_edit: true }; }
  // The trip's own PDFs, for snapshot editors to show in a snapshot; notes in the library never reach a trip's files.
  if (input.action === 'file') {
    await requireTripEdit(ctx, tripId);
    const source = text(input.source, 2048, 'image source'); const file = tripFileSource(source);
    if (!file || file.tripId !== tripId) fail(404, 'Image not found.');
    return { source, ...imageData(await ctx.files.getContent(tripId, file.fileId), 'trip file') };
  }
  // Places, bookings, days and stays a snapshot shows as cards: the ones it references, or for its editors every one there is.
  if (input.action === 'objects') {
    if (input.refs !== undefined) return trekObjects.resolve(ctx, tripId, input.refs);
    await requireTripEdit(ctx, tripId);
    return trekObjects.list(ctx, tripId);
  }
  if (input.action === 'files') {
    await requireTripEdit(ctx, tripId);
    return (await ctx.files.list(tripId)).flatMap((file) => {
      const name = String(file.original_name || file.name || file.filename || '');
      const size = Number(file.file_size ?? file.size) || 0;
      const pdf = (file.mime_type || file.mimetype) === 'application/pdf' || /\.pdf$/i.test(name);
      return pdf && size <= maxPdfBytes ? [{ source: `fieldnotes://trip-file/${tripId}/${file.id}`, name, size,
        created_at: file.created_at || null }] : [];
    });
  }
  if (input.action === 'unlink') {
    const noteId = id(input.note_id);
    await requireTripEdit(ctx, tripId);
    const remover = await tripActor(ctx, trip, sender);
    // The library removes only live references: a snapshot is the trip's own copy, removed from the trip's page.
    if (input.mode !== undefined && (await tripLink(ctx, tripId, noteId)).mode !== input.mode)
      fail(409, 'This trip keeps its own snapshot of this note. Remove it on the trip’s page.');
    // It waits in the trip's Recently deleted, with its comments, folder and copy, until recovered or deleted permanently.
    const { changes } = await ctx.db.exec(`UPDATE trip_note_links SET removed_at = ?, removed_by = ?
      WHERE trip_id = ? AND note_id = ? AND removed_at IS NULL`, new Date().toISOString(), remover, tripId, noteId);
    if (changes !== 1) fail(404, 'Linked note not found.');
    snapshotCollab.forget(snapshotKey(tripId, noteId));
    return { removed: true };
  }
  if (['deleted', 'deleted_recover', 'deleted_delete'].includes(input.action)) {
    await requireTripEdit(ctx, tripId);
    return tripDeletedAction(ctx, trip, await tripActor(ctx, trip, sender), input);
  }
  if (['comments', 'comment_add', 'comment_edit', 'comment_delete', 'comment_resolve', 'snapshot_save', 'snapshot_convert',
    'upload'].includes(input.action)) {
    const actorId = await tripActor(ctx, trip, sender);
    if (input.action === 'snapshot_save') return saveSnapshot(ctx, trip, input, actorId);
    if (input.action === 'snapshot_convert') return convertToSnapshot(ctx, trip, input, actorId);
    // Only snapshot editors upload from a trip; the image is copied into the snapshot when it is saved.
    if (input.action === 'upload') { await requireTripEdit(ctx, tripId); return uploads.upload(ctx, actorId, input); }
    return commentAction(input, ctx, trip, actorId);
  }
  fail(400, 'Unknown action.');
}

async function folderPath(ctx, folderId) {
  const folders = await folderTree(ctx);
  const names = []; const seen = new Set(); let currentId = folderId;
  while (currentId) {
    if (seen.has(currentId) || names.length > 64) fail(409, 'Folder hierarchy is cyclic.');
    seen.add(currentId);
    const folder = folders.get(currentId);
    if (!folder) return '';
    names.unshift(folder.name); currentId = folder.parent_id;
  }
  return names.join('/');
}

// `[[target]]` or `[[target|label]]`. The editor inserts a note id as the target, so renaming a note never breaks links to it;
// a title or folder path typed by hand still resolves, as before. A target may end in `#heading`; with nothing before the `#`
// it points into the note it sits in, so it links no other note.
const wikilinkPattern = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
const linkNote = (target) => target.split('#')[0].trim();
const linkHeading = (target) => (target.includes('#') ? target.slice(target.indexOf('#') + 1).trim() : '');
const noteIdPattern = new RegExp(`^(?:fieldnotes://note/)?(${UUID})$`, 'i');
const noteIdOf = (raw) => noteIdPattern.exec(raw)?.[1].toLowerCase();
const noteUrlPattern = new RegExp(`\\]\\(fieldnotes://note/(${UUID})\\)`, 'gi');
const linkTargetLimit = 8;
// Inside a trip a link reaches only the notes shared with that trip.
const tripTarget = (notes, raw) => notes.find((item) => !item.unavailable
  && (item.id === noteIdOf(raw) || item.title === raw || item.title === raw.split('/').at(-1)));
// Every note a text links to: wikilink targets as written, but not trip items, and Markdown links to a note as its id.
const linksIn = (content) => [...String(content).matchAll(wikilinkPattern)].map((match) => linkNote(match[1]))
  .filter((target) => target && !target.startsWith('trek:'))
  .concat([...String(content).matchAll(noteUrlPattern)].map((match) => match[1].toLowerCase()));
// A note's headings, in order and outside code blocks, for linking to one of them.
function headingsOf(content) {
  const found = []; let fenced = false;
  for (const line of String(content).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && /^#{1,6}\s+(.+)$/.exec(line);
    if (match) found.push(match[1].replace(/\s+#+\s*$/, '').trim());
  }
  return found.slice(0, 50);
}

// With `embed`, a note the reader may open also brings its text, so `![[note]]` can show it in place. `trip` has been checked.
async function resolveReference(ctx, userId, reference, trip = null, embed = false) {
  const raw = text(reference, 300, 'reference').trim();
  const found = (note) => ({ reference: raw, id: note.id, title: note.title, ...(embed ? { content: note.content } : {}) });
  if (trip) {
    const target = tripTarget((await tripNotes(ctx, trip)).notes, raw);
    return target ? found(target) : { reference: raw, unavailable: true };
  }
  const noteId = noteIdOf(raw);
  if (noteId) {
    try { return found(await readable(ctx, userId, noteId)); } catch { return { reference: raw, unavailable: true }; }
  }
  const title = raw.split('/').at(-1);
  const [rows, access] = await Promise.all([
    ctx.db.query('SELECT * FROM notes WHERE archived = 0 AND title = ? ORDER BY updated_at DESC, id', title), listAccessData(ctx, userId),
  ]);
  for (const row of rows) {
    if (!noteAccessFromRows(userId, row, access).canRead) continue;
    if (raw.includes('/')) {
      const path = row.folder_id ? await folderPath(ctx, row.folder_id) : '';
      if (`${path ? `${path}/` : ''}${row.title}` !== raw) continue;
    }
    return found(decode(row));
  }
  return { reference: raw, unavailable: true };
}

// Notes `[[` can point at, best title match first: the reader's own library, or in a trip only the notes shared with it.
// Image icons stay out of the list; they are large and the picker shows a glyph instead.
// With `headings`, each also lists its headings, so `[[note#` can offer them.
async function linkTargets(ctx, userId, { q = '', exclude = null, trip = null, headings = false }) {
  const needle = text(q, 120, 'search').trim().toLocaleLowerCase();
  const excluded = exclude ? id(exclude) : null;
  let candidates;
  if (trip) candidates = (await tripNotes(ctx, trip)).notes.filter((item) => !item.unavailable);
  else {
    const [rows, access] = await Promise.all([ctx.db.query(`SELECT id, owner_id, title, icon, visibility, folder_id
      ${headings ? ', content' : ''} FROM notes WHERE archived = 0 ORDER BY updated_at DESC, id`), listAccessData(ctx, userId)]);
    candidates = rows.filter((row) => {
      const rights = noteAccessFromRows(userId, row, access);
      return row.owner_id === userId || Boolean(rights.directRole) || rights.inheritedRole > 0;
    });
  }
  const closeness = (title) => {
    const value = title.toLocaleLowerCase();
    if (!needle || value.startsWith(needle)) return 0;
    if (value.split(/[\s\-_/·]+/).some((word) => word.startsWith(needle))) return 1;
    return value.includes(needle) ? 2 : -1;
  };
  const found = candidates.filter((item) => item.id !== excluded).map((item, order) => ({ item, order, score: closeness(item.title) }))
    .filter(({ score }) => score >= 0).sort((a, b) => a.score - b.score || a.order - b.order).slice(0, linkTargetLimit);
  // In the library the excluded note is the one being edited: flag targets some of its readers could not open.
  let restricted = () => false;
  if (!trip && excluded && found.length) {
    const source = await readable(ctx, userId, excluded).catch(() => null);
    if (source) {
      const audience = await audienceOf(ctx, source);
      const holding = await tripsHolding(ctx, found.map(({ item }) => item.id));
      restricted = (item) => gapOpen(linkGap(audience, item, holding.get(item.id)));
    }
  }
  return { notes: await Promise.all(found.map(async ({ item }) => ({ id: item.id, title: item.title,
    icon: item.icon && !item.icon.startsWith('data:') ? item.icon : null, restricted: restricted(item),
    path: !trip && item.folder_id ? await folderPath(ctx, item.folder_id) : '',
    ...(headings ? { headings: headingsOf(item.content) } : {}) }))) };
}

// Stands in for a link the reader cannot open; the page shows it as its locked label, never the stored title or id.
const lockedLink = '\uE000';
const snippetLine = (content, links) => String(content).split('\n').find((value) => linksIn(value).some(links)) || '';

// The line around a note's first link to the target, with links shown as their labels and Markdown marks dropped.
function backlinkSnippet(line, titleOf) {
  // Labels follow the page: an id link shows the note's current title, a hand-typed one its own label.
  const plain = line.replace(wikilinkPattern, (_match, target, label) => {
    const note = linkNote(target); const heading = linkHeading(target);
    if (!note) return label?.trim() || heading;
    if (!noteIdPattern.test(note)) return label?.trim() || `${note.split('/').at(-1)}${heading ? ` › ${heading}` : ''}`;
    const title = titleOf(note);
    return title === undefined ? lockedLink : `${title}${heading ? ` › ${heading}` : ''}`;
  })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, '').replace(/[*_~`]/g, '').trim();
  return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
}

// Where a title appears as plain text: outside code, links, URLs and HTML, and as a whole word wherever words are spaced
// (CJK, Thai and Korean text runs words together). Returns offsets into `content`; case does not matter.
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const wordChar = /[\p{L}\p{N}]/u;
const unlinkable = /^(```|~~~)[\s\S]*?^\1.*$|`[^`\n]*`|!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+/gm;
function mentionsIn(content, title) {
  const needle = title.trim().toLowerCase(); const written = String(content);
  const haystack = written.replace(unlinkable, (match) => ' '.repeat(match.length)).toLowerCase();
  // Lower-casing that changes a string's length would move the offsets; such rare titles simply find nothing.
  if (Array.from(needle).length < 2 || needle.length !== title.trim().length || haystack.length !== written.length) return [];
  const apart = (edge, next) => !next || unspaced.test(edge) || unspaced.test(next) || !wordChar.test(edge) || !wordChar.test(next);
  const found = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    if (apart(needle[0], written[at - 1]) && apart(needle.at(-1), written[at + needle.length])) found.push(at);
  }
  return found;
}

// Notes that link to this one and that the reader may open: any readable note in the library, or the trip's notes in a trip.
// `mentions` lists the others that name it without a link; in the library, ones the reader may edit can be linked at once.
async function backlinks(ctx, userId, noteId, trip = null) {
  const targetId = id(noteId);
  let target; let sources; let resolves;
  if (trip) {
    const notes = (await tripNotes(ctx, trip)).notes;
    target = notes.find((item) => item.id === targetId && !item.unavailable) || fail(404, 'Note not found.');
    sources = notes.filter((item) => !item.unavailable && item.id !== targetId);
    resolves = async (raw) => tripTarget(notes, raw)?.id === targetId;
  } else {
    target = await readable(ctx, userId, targetId);
    const [rows, access] = await Promise.all([ctx.db.query(`SELECT id, owner_id, title, content, icon, visibility, folder_id, updated_at
      FROM notes WHERE archived = 0 AND id != ? AND (instr(lower(content), ?) > 0 OR instr(lower(content), lower(?)) > 0)
      ORDER BY updated_at DESC, id`, targetId, targetId, target.title), listAccessData(ctx, userId)]);
    sources = rows.map((row) => ({ row, rights: noteAccessFromRows(userId, row, access) })).filter(({ rights }) => rights.canRead)
      .map(({ row, rights }) => ({ ...row, can_link: rights.role >= 2 }));
    const resolved = new Map();
    resolves = async (raw) => {
      if (noteIdOf(raw) === targetId) return true;
      if (noteIdPattern.test(raw) || raw.split('/').at(-1) !== target.title) return false;
      if (!resolved.has(raw)) resolved.set(raw, (await resolveReference(ctx, userId, raw)).id === targetId);
      return resolved.get(raw);
    };
  }
  const found = []; const mentioned = [];
  for (const source of sources) {
    const matching = new Set();
    for (const raw of new Set(linksIn(source.content))) if (await resolves(raw)) matching.add(raw);
    if (matching.size) { found.push({ source, line: snippetLine(source.content, (raw) => matching.has(raw)) }); continue; }
    const [first] = mentionsIn(source.content, target.title);
    if (first !== undefined) {
      const start = source.content.lastIndexOf('\n', first) + 1; const end = source.content.indexOf('\n', first);
      mentioned.push({ source, line: source.content.slice(start, end < 0 ? undefined : end) });
    }
  }
  // Other notes a snippet links to show their titles only when the reader may open them.
  const titles = new Map([[targetId, target.title], ...sources.map((item) => [item.id, item.title])]);
  const others = [...new Set([...found, ...mentioned].flatMap(({ line }) => linksIn(line).map(noteIdOf)
    .filter((noteId) => noteId && !titles.has(noteId))))];
  if (others.length && !trip) {
    const [rows, access] = await Promise.all([ctx.db.query(`SELECT id, owner_id, title, visibility, folder_id FROM notes
      WHERE archived = 0 AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(others)), listAccessData(ctx, userId)]);
    for (const row of rows) if (noteAccessFromRows(userId, row, access).canRead) titles.set(row.id, row.title);
  }
  const titleOf = (raw) => titles.get(noteIdOf(raw));
  const entry = ({ source, line }) => ({ id: source.id, title: source.title,
    icon: source.icon && !source.icon.startsWith('data:') ? source.icon : null, snippet: backlinkSnippet(line, titleOf) });
  return { notes: found.map(entry),
    mentions: mentioned.map((item) => ({ ...entry(item), can_link: !trip && item.source.can_link === true })) };
}

// Turns every plain mention of the target's title in one note into a link to it, as one edit of that note.
async function linkMentions(ctx, userId, input) {
  const source = await editable(ctx, userId, input.note_id);
  const target = await readable(ctx, userId, input.target_id);
  const length = target.title.trim().length; let content = source.content;
  const positions = mentionsIn(content, target.title);
  for (const at of positions.reverse()) {
    const said = content.slice(at, at + length).replace(/[[\]|]/g, ' ');
    content = `${content.slice(0, at)}[[${target.id}|${said}]]${content.slice(at + length)}`;
  }
  if (!positions.length) return { linked: 0 };
  noteFields({ title: source.title, content });
  await replaceNote(ctx, userId, source, source.version, { content });
  return { linked: positions.length };
}

// Everyone a note reaches: each person who can read it (owner, collaborators, folder members) with their access data, whether
// it is public, and the trips holding it. A link never grants access, so this is what decides who would find one dead.
async function audienceOf(ctx, row) {
  const folders = await folderTree(ctx);
  const chain = [];
  for (let current = row.folder_id; current && folders.has(current) && !chain.includes(current);) {
    chain.push(current); current = folders.get(current).parent_id;
  }
  const [noteRows, folderRows, links] = await Promise.all([
    ctx.db.query('SELECT user_id FROM note_collaborators WHERE note_id = ?', row.id),
    chain.length ? ctx.db.query('SELECT user_id FROM folder_collaborators WHERE folder_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(chain)) : [],
    ctx.db.query('SELECT trip_id FROM trip_note_links WHERE note_id = ? AND removed_at IS NULL', row.id),
  ]);
  const people = new Set([row.owner_id, ...chain.map((folderId) => folders.get(folderId).owner_id),
    ...noteRows.map((item) => item.user_id), ...folderRows.map((item) => item.user_id)]);
  const readers = new Map();
  for (const userId of people) {
    const access = await listAccessData(ctx, userId, true, folders);
    if (noteAccessFromRows(userId, row, access).canRead) readers.set(userId, access);
  }
  const anyAccess = readers.get(row.owner_id) || await listAccessData(ctx, row.owner_id, true, folders);
  return { readers, anyAccess, public: noteAccessFromRows(row.owner_id, row, anyAccess).publicReadable,
    trips: links.map((link) => link.trip_id) };
}

// Who can read the source note but not the target: people, the public when only the source is public, and trips holding only
// the source (a trip page resolves links among its own notes).
function linkGap(source, target, targetTrips) {
  const people = [...source.readers].filter(([userId, access]) => !noteAccessFromRows(userId, target, access).canRead)
    .map(([userId]) => userId);
  return { people, trips: source.trips.filter((tripId) => !targetTrips.has(tripId)),
    public: source.public && !noteAccessFromRows(target.owner_id, target, source.anyAccess).publicReadable };
}
const gapOpen = (gap) => gap.people.length > 0 || gap.trips.length > 0 || gap.public;
const tripsHolding = async (ctx, noteIds) => {
  const rows = noteIds.length ? await ctx.db.query(
    'SELECT trip_id, note_id FROM trip_note_links WHERE note_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL',
    JSON.stringify(noteIds)) : [];
  const trips = new Map(noteIds.map((noteId) => [noteId, new Set()]));
  for (const row of rows) trips.get(row.note_id).add(row.trip_id);
  return trips;
};

// For an editor of `noteId`: which of its linked notes some of its readers cannot open, and what the editor could do about it.
// People are named only to someone who may edit the note; trips are named only when the editor belongs to them.
async function linkAccess(ctx, userId, noteId, targetIds) {
  const source = await editable(ctx, userId, noteId);
  const audience = await audienceOf(ctx, source);
  const targets = [];
  for (const targetId of targetIds) {
    try { targets.push(await readable(ctx, userId, targetId)); } catch { /* a link the editor cannot open has nothing to share */ }
  }
  const holding = await tripsHolding(ctx, targets.map((target) => target.id));
  const [candidates, mine] = await Promise.all([collaborationCandidates(ctx, userId), ctx.trips.listMine()]);
  const tripTitles = new Map(mine.map((trip) => [Number(trip.id), trip.title]));
  const links = [];
  for (const target of targets) {
    const gap = linkGap(audience, target, holding.get(target.id));
    if (!gapOpen(gap)) continue;
    const owner = target.owner_id === userId;
    links.push({ target: { id: target.id, title: target.title }, can_share: owner, public: gap.public,
      people: await Promise.all(gap.people.map(async (personId) => ({
        user: candidates.get(personId) || await ctx.users.getById(personId) || { id: personId },
        grantable: owner && candidates.has(personId) }))),
      trips: gap.trips.filter((tripId) => tripTitles.has(tripId)).map((tripId) => ({ id: tripId, title: tripTitles.get(tripId) })),
      hidden_trips: gap.trips.filter((tripId) => !tripTitles.has(tripId)).length });
  }
  return { links };
}

// The owner of a linked note lets the source's readers open it, through the two ways Fieldnotes already shares a note: as a
// viewer, or as a live reference in a trip. Both stay visible and undoable where they always were.
async function grantLinkAccess(ctx, userId, input) {
  const target = await owned(ctx, userId, input.target_id);
  const userIds = Array.isArray(input.user_ids) ? input.user_ids.map(userNumber) : [];
  const tripIds = Array.isArray(input.trip_ids) ? input.trip_ids.map(number) : [];
  if (userIds.length > 100 || tripIds.length > 20) fail(400, 'Invalid collaborator changes.');
  const [current] = (await linkAccess(ctx, userId, input.note_id, [target.id])).links;
  const people = new Set((current?.people || []).filter((person) => person.grantable).map((person) => Number(person.user.id)));
  const trips = new Set((current?.trips || []).map((trip) => trip.id));
  if (userIds.some((personId) => !people.has(personId)) || tripIds.some((tripId) => !trips.has(tripId)))
    fail(400, 'Invalid collaborator changes.');
  if (userIds.length) await collaboratorAction({ action: 'bulk_roles', note_id: target.id,
    changes: userIds.map((personId) => ({ user_id: personId, role: 'viewer' })) }, ctx, userId);
  for (const tripId of tripIds) await createTripLink(ctx, userId, { note_id: target.id, trip_id: tripId, mode: 'live' });
  return linkAccess(ctx, userId, input.note_id, [target.id]);
}

async function listNotes(ctx, userId, { search = '', offset = 0, publicOnly = false, folderId = null,
  sort = 'updated', order = 'desc', locale, limit = pageSize }) {
  // The list carries no note text: the page reads a note whole when it opens or previews one, and only a search needs it here.
  const [rows, access] = await Promise.all([
    ctx.db.query(`SELECT id, owner_id, title, tags, properties, icon, version, created_at, updated_at, visibility, folder_id
      ${search ? ', content' : ''} FROM notes WHERE archived = 0 ORDER BY updated_at DESC, id`),
    listAccessData(ctx, userId, !publicOnly),
  ]);
  const visible = [];
  for (const row of rows) {
    if (folderId !== null && row.folder_id !== folderId) continue;
    const { content: _content, ...note } = decode(row);
    const found = rank(search, { ...note, content: row.content ?? '' }, `${note.tags.join('\n')}\n${propertyText(note.properties)}`);
    if (!found) continue;
    // A note whose folder chain is broken stays out of the list rather than failing it.
    let rights;
    try { rights = noteAccessFromRows(userId, row, access); } catch { continue; }
    const listed = publicOnly ? row.visibility === 'public' && rights.publicReadable
      : row.owner_id === userId || Boolean(rights.directRole) || rights.inheritedRole > 0;
    if (listed) visible.push(search ? { ...note, score: found.score, snippet: found.snippet } : note);
  }
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const direction = order === 'asc' ? 1 : -1;
  // A search lists the best matches first; the chosen sort orders notes that match as well.
  visible.sort((a, b) => (b.score || 0) - (a.score || 0) || direction * noteSorts[sort](a, b, collator) || a.id.localeCompare(b.id));
  return { notes: visible.slice(offset, offset + limit).map(({ score: _score, ...note }) => note),
    has_more: visible.length > offset + limit };
}

const uploads = createAssets({ fail });
const parts = createParts({ fail });
const history = createHistory({ fail, editable });
const trekObjects = createTrekObjects({ fail });
// A deleted note waits in its owner's Recently deleted for 30 days, with its files and versions, then is deleted permanently
// with its sharing rows; the history and files then follow on their own sweeps. A note removed from a trip waits as long in
// the trip's Recently deleted, then is deleted permanently with its threads, folder place and snapshot copy. The purge runs at
// most every ten minutes, when someone opens a note to edit or a trip's Recently deleted; both lists hide what is past its
// time even before then.
const DELETED_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 10 * 60 * 1000;
let purgedAt = 0;
const purgeNotes = (where) => [
  { sql: `DELETE FROM note_collaborators WHERE note_id IN (SELECT id FROM notes WHERE ${where.sql})`, args: where.args },
  { sql: `DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE ${where.sql})`, args: where.args },
  { sql: `DELETE FROM notes WHERE ${where.sql}`, args: where.args }];
// What leaves with a trip's removed notes: their folder places, threads, snapshot copies with images, and co-editing and history.
const purgeTripLinks = (where, args) => [
  ...['trip_note_folders', 'trip_note_comments', 'snapshot_assets', 'trip_note_snapshots'].map((table) => ({ args,
    sql: `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM trip_note_links l WHERE l.trip_id = ${table}.trip_id
      AND l.note_id = ${table}.note_id AND ${where})` })),
  ...['note_crdt', 'note_updates', 'note_presence', 'note_versions'].map((table) => ({ args,
    sql: `DELETE FROM ${table} WHERE note_id IN (SELECT ${snapshotKeySql('l.')} FROM trip_note_links l WHERE ${where})` })),
  { sql: `DELETE FROM trip_note_links AS l WHERE ${where}`, args }];
const deletedBefore = () => new Date(Date.now() - DELETED_KEPT_MS).toISOString();
async function purgeDeleted(ctx) {
  if (Date.now() - purgedAt < PURGE_EVERY_MS) return;
  purgedAt = Date.now();
  await ctx.db.tx([...purgeNotes({ sql: 'archived = 1 AND archived_at < ?', args: [deletedBefore()] }),
    ...purgeTripLinks('l.removed_at < ?', [deletedBefore()])]);
}

// Recently deleted: the owner's deleted notes, newest first, and one of them read whole for its preview.
const purgeAt = (at) => new Date(Date.parse(at) + DELETED_KEPT_MS).toISOString();
async function deletedNote(ctx, userId, noteId) {
  const [row] = await ctx.db.query('SELECT * FROM notes WHERE id = ? AND owner_id = ? AND archived = 1 AND archived_at >= ?',
    id(noteId), userId, deletedBefore());
  if (!row) fail(404, 'This note is no longer in Recently deleted.');
  return row;
}
async function listDeleted(ctx, userId, noteId) {
  if (noteId) {
    const row = await deletedNote(ctx, userId, noteId);
    return { ...decode(row), deleted_at: row.archived_at, purge_at: purgeAt(row.archived_at) };
  }
  const rows = await ctx.db.query(`SELECT id, title, icon, archived_at FROM notes WHERE owner_id = ? AND archived = 1 AND archived_at >= ?
    ORDER BY archived_at DESC, id`, userId, deletedBefore());
  return rows.map((row) => ({ id: row.id, title: row.title, icon: row.icon, deleted_at: row.archived_at,
    purge_at: purgeAt(row.archived_at) }));
}
// Recovering puts a note back where it was, or at the top of the library when that folder is gone or no longer the owner's to
// write in; its trip references and sharing come back with it. Deleting permanently cannot be undone.
async function deletedAction(ctx, userId, input) {
  const row = await deletedNote(ctx, userId, input.id);
  if (input.action === 'recover') {
    const folder = row.folder_id ? await folderAccess(ctx, userId, row.folder_id) : null;
    const folderId = folder && roleValue(folder.role) >= 2 ? row.folder_id : null;
    const { results } = await ctx.db.tx([
      { sql: `UPDATE notes SET archived = 0, archived_at = NULL, folder_id = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND archived = 1`, args: [folderId, row.id, userId] },
      ...uploads.referenceOps('', row.content),
    ]);
    if (results[0].changes !== 1) fail(404, 'This note is no longer in Recently deleted.');
    return owned(ctx, userId, row.id);
  }
  if (input.action === 'delete') {
    await ctx.db.tx(purgeNotes({ sql: 'id = ? AND owner_id = ? AND archived = 1', args: [row.id, userId] }));
    await uploads.sweep(ctx);
    return { deleted: true };
  }
  fail(400, 'Unknown action.');
}

// A trip's Recently deleted, for the people who may edit the trip: what was removed from it in the last 30 days, newest first.
// A snapshot shows its own copy; a live reference shows the note only while the trip may still see it, as the trip page does.
async function tripDeleted(ctx, trip, noteId = null) {
  const links = await ctx.db.query(`SELECT note_id, mode, removed_at FROM trip_note_links WHERE trip_id = ? AND removed_at >= ?
    ${noteId ? 'AND note_id = ?' : ''} ORDER BY removed_at DESC, note_id`, trip.id, deletedBefore(), ...(noteId ? [noteId] : []));
  if (!links.length) return [];
  const ids = JSON.stringify(links.map((link) => link.note_id));
  const [snapshots, notes, members] = await Promise.all([
    ctx.db.query('SELECT * FROM trip_note_snapshots WHERE trip_id = ? AND note_id IN (SELECT value FROM json_each(?))', trip.id, ids),
    ctx.db.query('SELECT * FROM notes WHERE archived = 0 AND id IN (SELECT value FROM json_each(?))', ids),
    ctx.trips.members(trip.id),
  ]);
  const memberIds = new Set([trip.user_id, ...members.map((member) => member.id)].map(Number));
  const copies = new Map(snapshots.map((row) => [row.note_id, row])); const originals = new Map(notes.map((row) => [row.id, row]));
  return links.map((link) => {
    const row = link.mode === 'snapshot' ? copies.get(link.note_id) : originals.get(link.note_id);
    const shown = row && (link.mode === 'snapshot' || row.visibility === 'public' || memberIds.has(Number(row.owner_id)));
    return { id: link.note_id, mode: link.mode, deleted_at: link.removed_at, purge_at: purgeAt(link.removed_at),
      ...(shown ? { note: decode(row) } : { unavailable: true }) };
  });
}
// Recovering puts a removed note back in its trip folder, or at the top when that folder is gone. A live reference shares the
// note again, so it follows the rule for sharing one live: the author's own, or a note anyone may read.
async function tripDeletedAction(ctx, trip, actorId, input) {
  if (input.action === 'deleted' && !input.note_id) {
    await purgeDeleted(ctx);
    return (await tripDeleted(ctx, trip)).map(({ note, ...item }) => ({ ...item, title: note?.title ?? null, icon: note?.icon ?? null }));
  }
  const noteId = id(input.note_id);
  const [item] = await tripDeleted(ctx, trip, noteId);
  if (!item) fail(404, 'This note is no longer in Recently deleted.');
  if (input.action === 'deleted') {
    const { note, ...rest } = item;
    return note ? { ...rest, title: note.title, icon: note.icon ?? null, content: note.content, properties: note.properties,
      updated_at: note.updated_at } : { ...rest, title: null, icon: null, content: '', properties: [] };
  }
  const where = 'l.trip_id = ? AND l.note_id = ? AND l.removed_at IS NOT NULL';
  if (input.action === 'deleted_delete') { await ctx.db.tx(purgeTripLinks(where, [trip.id, noteId])); return { deleted: true }; }
  if (input.action !== 'deleted_recover') fail(400, 'Unknown action.');
  if (item.mode === 'live') {
    const [note] = await ctx.db.query('SELECT * FROM notes WHERE id = ?', noteId);
    const mayShare = note && (note.owner_id === actorId || (!note.archived && (await noteAccess(ctx, actorId, note)).publicReadable));
    if (!mayShare) fail(403, 'Only the author can share this note live again.');
  }
  const [folder] = await ctx.db.query(`SELECT f.id FROM trip_note_folders a
    JOIN trip_folders f ON f.id = a.folder_id AND f.trip_id = a.trip_id WHERE a.trip_id = ? AND a.note_id = ? AND f.archived = 0`,
  trip.id, noteId);
  await ctx.db.tx([
    ...(folder ? [] : [{ sql: 'DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?', args: [trip.id, noteId] }]),
    { sql: 'UPDATE trip_note_links SET removed_at = NULL, removed_by = NULL WHERE trip_id = ? AND note_id = ? AND removed_at IS NOT NULL',
      args: [trip.id, noteId] },
  ]);
  return tripNote(ctx, trip, noteId, actorId);
}
const collab = createCollab({ fail, id, editable, noteFields, propertyFields, noteIcon,
  referenceOps: async (ctx, noteId, before, after) => uploads.referenceOps(before, after), beforeWrite: history.beforeWrite,
  sweep: async (ctx) => { await uploads.sweep(ctx); await history.prune(ctx); await purgeDeleted(ctx); } });

// A trip's snapshot, edited live by the people who may edit the trip. Its key names the trip, so the same note frozen into two
// trips stays two documents.
const SNAPSHOT_KEY = new RegExp(`^trip:(\\d{1,12}):(${UUID})$`, 'i');
function snapshotId(value) {
  const match = SNAPSHOT_KEY.exec(String(value ?? ''));
  if (!match) fail(400, 'Invalid value: {field}.', { field: 'note' });
  return snapshotKey(Number(match[1]), id(match[2]));
}
async function snapshotEditable(ctx, userId, key) {
  const { tripId, noteId } = snapshotParts(snapshotId(key));
  const trip = await checkTrip(ctx, tripId);
  await tripActor(ctx, trip, userId);
  await requireTripEdit(ctx, trip.id);
  const [row] = await ctx.db.query(`SELECT s.* FROM trip_note_snapshots s JOIN trip_note_links l USING (trip_id, note_id)
    WHERE s.trip_id = ? AND s.note_id = ? AND l.removed_at IS NULL`, trip.id, noteId);
  if (!row) fail(404, 'Snapshot not found.');
  return { ...decode(row), id: key };
}
// Images a snapshot gains are copied in as they appear, in transactions of their own so a large paste stays within the SDK's cap;
// copies it stops showing go when an editor next joins, so an undone deletion still finds its image.
async function captureNewSnapshotImages(ctx, key, before, after) {
  const sources = imageSources(after);
  if (JSON.stringify(sources) === JSON.stringify(imageSources(before))) return [];
  if (sources.length > maxSnapshotAssets) fail(400, 'A snapshot can include at most {count} images.', { count: maxSnapshotAssets });
  const { tripId, noteId } = snapshotParts(key);
  const stored = await ctx.db.query('SELECT source, size FROM snapshot_assets WHERE trip_id = ? AND note_id = ?', tripId, noteId);
  const known = new Set(stored.map((row) => row.source));
  const kept = stored.filter((row) => sources.includes(row.source)).reduce((total, row) => total + row.size, 0);
  const added = await captureSnapshotAssets(ctx, sources.filter((source) => !known.has(source)), kept, tripId);
  await inBatches(ctx, copyOps(tripId, noteId, added));
  return [];
}
// What co-editing leaves behind once snapshots are gone: their documents, pending updates, cursors and versions. It scans, so
// only removing a person's data runs it; a trip's removed notes take theirs along by key.
const snapshotLeftovers = () => ['note_crdt', 'note_updates', 'note_presence', 'note_versions'].map((table) => ({
  sql: `DELETE FROM ${table} WHERE note_id LIKE 'trip:%' AND note_id NOT IN (SELECT ${snapshotKeySql()} FROM trip_note_snapshots)` }));
const snapshotHistory = createHistory({ fail, editable: snapshotEditable, source: SNAPSHOTS });
const snapshotCollab = createCollab({ fail, id: snapshotId, editable: snapshotEditable, noteFields, propertyFields, noteIcon,
  referenceOps: captureNewSnapshotImages, beforeWrite: snapshotHistory.beforeWrite, source: SNAPSHOTS,
  sweep: async (ctx, key) => {
    await snapshotHistory.prune(ctx);
    const { tripId, noteId } = snapshotParts(key);
    // A copy stays while the snapshot or any version it keeps still shows it.
    const shown = await ctx.db.query(`SELECT content FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ?
      UNION ALL SELECT content FROM note_versions WHERE note_id = ?`, tripId, noteId, key);
    if (shown.length) await ctx.db.exec(`DELETE FROM snapshot_assets WHERE trip_id = ? AND note_id = ?
      AND source NOT IN (SELECT value FROM json_each(?))`, tripId, noteId,
    JSON.stringify([...new Set(shown.flatMap((row) => imageSources(row.content)))]));
  } });

// Writes over a note the caller may edit, at the version they last saw: the version history keeps what it replaces, and open
// co-editing sessions receive the change. `fields` left out keep their stored value.
async function replaceNote(ctx, userId, current, version, fields, { force = false } = {}) {
  const { title = current.title, content = current.content, tags, properties, icon, visibility = current.visibility,
    folderId = current.folder_id } = fields;
  const { results } = await ctx.db.tx([...history.beforeWrite(current.id, userId, { force, version }), {
    sql: `UPDATE notes SET title = ?, content = ?, tags = COALESCE(?, tags), properties = COALESCE(?, properties),
      icon = CASE WHEN ? THEN ? ELSE icon END, visibility = ?, folder_id = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND archived = 0`,
    args: [title, content, tags ?? null, properties ?? null, icon !== undefined ? 1 : 0, icon ?? null, visibility, folderId,
      new Date().toISOString(), current.id, version] }]);
  if (results.at(-1)?.changes !== 1) fail(409, 'This note changed. Reload before saving.');
  await uploads.track(ctx, current.content, content); await uploads.sweep(ctx);
  const saved = await readable(ctx, userId, current.id);
  await collab.external(ctx, saved);
  return saved;
}

// Puts an earlier version back as a new change, after keeping the current text as a version of its own, so a restore can be
// undone the same way.
async function restoreVersion(ctx, userId, input) {
  const current = await editable(ctx, userId, input.note_id);
  const version = await history.read(ctx, userId, current.id, input.version_id);
  const { content } = noteFields({ title: version.title, content: version.content });
  return replaceNote(ctx, userId, current, input.version, { title: version.title, content,
    properties: propertyFields(version.properties), icon: noteIcon(version.icon) }, { force: true });
}

async function handle(action, req, ctx) {
  const userId = actor(req);
  if (action === 'part') return parts.store(ctx, userId, req.body);
  const body = await parts.expand(ctx, userId, req.body || {});
  const query = req.query || {};
  if (action === 'trips') return ctx.trips.listMine();
  if (action === 'folders') return listFolders(ctx, userId);
  if (action === 'folder') return folderAction({ ...body, ...query }, ctx, userId);
  if (action === 'reference') {
    return resolveReference(ctx, userId, query.ref, query.trip_id ? await checkTrip(ctx, query.trip_id) : null, query.embed === '1');
  }
  if (action === 'link_targets') return linkTargets(ctx, userId, { q: query.q, exclude: query.exclude, headings: query.headings === '1' });
  if (action === 'backlinks') return backlinks(ctx, userId, query.note_id);
  if (action === 'link_access') {
    const targets = text(query.targets || '', 20 * 37, 'reference').split(',').filter(Boolean);
    if (targets.length > 20) fail(400, 'Invalid value: {field}.', { field: 'reference' });
    return linkAccess(ctx, userId, query.note_id, targets.map(id));
  }
  if (action === 'link_grant') return grantLinkAccess(ctx, userId, body);
  if (action === 'link_mentions') return linkMentions(ctx, userId, body);
  if (action === 'history') return history.list(ctx, userId, query.note_id);
  if (action === 'version') return history.read(ctx, userId, query.note_id, query.id);
  if (action === 'restore') return restoreVersion(ctx, userId, body);
  if (action === 'asset') return asset(ctx, userId, query);
  if (action === 'assets') return assets(ctx, userId, body);
  if (action === 'upload') return uploads.upload(ctx, userId, body);
  if (action === 'collaborators') return collaborators(ctx, userId, query.note_id);
  if (action === 'collaborator') return collaboratorAction(body, ctx, userId);
  if (action === 'trip') {
    if (body.action === 'begin_note') fail(400, 'Trip note intents must come from the companion plugin.');
    return tripAction({ ...body, ...query }, ctx, userId);
  }
  if (action === 'collab') return collab.action(body, ctx, userId);
  // Visibility is owner-only and outside the shared document, so co-editing never changes who can read a note.
  if (action === 'note_settings') {
    const note = await owned(ctx, userId, body.id);
    if (!['private', 'public'].includes(body.visibility)) fail(400, 'Invalid visibility.');
    await ctx.db.exec('UPDATE notes SET visibility = ? WHERE id = ?', body.visibility, note.id);
    return owned(ctx, userId, note.id);
  }
  if (action === 'trip_intent') return takeTripNoteIntent(ctx, userId);
  if (action === 'trip_note') return createTripNote(ctx, userId, body);
  if (action === 'list' || action === 'public') {
    const search = text(query.q || '', 120, 'search');
    const offset = Number(query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'Invalid page.');
    const folderId = query.folder_id ? id(query.folder_id) : null;
    // The library's column view takes every note at once; pages stay the default.
    const limit = query.limit === undefined ? pageSize : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxListLimit) fail(400, 'Invalid page.');
    const sort = query.sort || 'updated'; const order = query.order || 'desc';
    if (!Object.hasOwn(noteSorts, sort) || !['asc', 'desc'].includes(order)) fail(400, 'Invalid sort order.');
    let locale;
    try { [locale] = Intl.Collator.supportedLocalesOf(text(query.locale || 'en', 35, 'locale')); } catch { fail(400, 'Invalid locale.'); }
    return listNotes(ctx, userId, { search, offset, folderId, sort, order, locale, limit, publicOnly: action === 'public' });
  }
  if (action === 'read') return readable(ctx, userId, query.id);
  if (action === 'save') {
    const { title, content, tags } = noteFields(body);
    const properties = body.properties === undefined ? undefined : propertyFields(body.properties);
    const icon = body.icon === undefined ? undefined : noteIcon(body.icon);
    if (body.visibility !== undefined && !['private', 'public'].includes(body.visibility)) fail(400, 'Invalid visibility.');
    const now = new Date().toISOString();
    if (body.id) {
      const current = await editable(ctx, userId, body.id);
      if (body.version !== current.version) fail(409, 'This note changed. Reload before saving.');
      if (body.visibility && body.visibility !== current.visibility && current.owner_id !== userId)
        fail(403, 'Only the owner can change visibility.');
      const folderId = body.folder_id === undefined ? current.folder_id : body.folder_id || null;
      if (folderId !== current.folder_id && current.owner_id !== userId) fail(403, 'Only the owner can move a note.');
      // Only a move needs folder rights; a direct editor of a note in someone else's folder may still save it.
      if (folderId && folderId !== current.folder_id) await folderForWrite(ctx, userId, folderId);
      // Omitted tags or properties keep their stored value, so older callers never wipe them.
      return replaceNote(ctx, userId, current, body.version, { title, content, tags, properties, icon,
        visibility: body.visibility || current.visibility, folderId });
    }
    const noteId = randomUUID();
    const visibility = body.visibility || 'private';
    const folderId = body.folder_id || null;
    if (folderId) await folderForWrite(ctx, userId, folderId);
    await ctx.db.exec(`INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at,
      updated_at, burst_at, edited_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json_array(?))`,
      noteId, userId, title, content, tags ?? '[]', properties ?? '[]', icon ?? null, visibility, folderId, now, now, now, userId);
    await uploads.track(ctx, '', content);
    return owned(ctx, userId, noteId);
  }
  if (action === 'deleted') return listDeleted(ctx, userId, query.id);
  if (action === 'deleted_action') return deletedAction(ctx, userId, body);
  if (action === 'archive') {
    const current = await owned(ctx, userId, body.id);
    // A deleted note's co-editing log goes with it; the guard leaves it alone when the note was not deleted after all.
    const deleted = 'EXISTS (SELECT 1 FROM notes WHERE id = ? AND archived = 1)';
    const { results } = await ctx.db.tx([
      { sql: `UPDATE notes SET archived = 1, archived_at = ?, version = version + 1 WHERE id = ? AND owner_id = ? AND version = ?`,
        args: [new Date().toISOString(), current.id, userId, body.version] },
      ...['note_presence', 'note_updates', 'note_crdt'].map((table) => ({
        sql: `DELETE FROM ${table} WHERE note_id = ? AND ${deleted}`, args: [current.id, current.id] })),
    ]);
    if (results[0].changes !== 1) fail(409, 'This note changed. Reload before deleting.');
    collab.forget(body.id);
    await uploads.track(ctx, current.content, ''); await uploads.sweep(ctx);
    return { archived: true };
  }
  if (action === 'link') return createTripLink(ctx, userId, body);
  fail(404, 'Unknown route.');
}

async function deleteUserData(ctx, userId) {
  await ctx.db.tx([
    { sql: 'DELETE FROM trip_note_intents WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM asset_uploads WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM request_parts WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM note_assets WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM note_presence WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId, userId] },
    { sql: 'DELETE FROM note_updates WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId] },
    { sql: 'DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId] },
    { sql: 'DELETE FROM note_crdt WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId] },
    // A thread goes with its opening comment; the links removed below take their discussions along.
    { sql: `DELETE FROM trip_note_comments WHERE author_id = ? OR parent_id IN (SELECT id FROM trip_note_comments WHERE author_id = ?)
      OR note_id IN (SELECT id FROM notes WHERE owner_id = ?) OR EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = trip_note_comments.trip_id AND l.note_id = trip_note_comments.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId, userId, userId, userId] },
    { sql: `DELETE FROM trip_note_folders WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = trip_note_folders.trip_id AND l.note_id = trip_note_folders.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
    { sql: `DELETE FROM snapshot_assets WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = snapshot_assets.trip_id AND l.note_id = snapshot_assets.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
    { sql: `DELETE FROM snapshot_assets WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
    { sql: `DELETE FROM trip_note_folders WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
    { sql: `DELETE FROM trip_note_snapshots WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)`, args: [userId] },
    { sql: `DELETE FROM trip_note_snapshots WHERE EXISTS (
      SELECT 1 FROM trip_note_links l WHERE l.trip_id = trip_note_snapshots.trip_id AND l.note_id = trip_note_snapshots.note_id
      AND (l.source_owner_id = ? OR l.linked_by = ?))`, args: [userId, userId] },
    { sql: 'DELETE FROM trip_note_links WHERE source_owner_id = ? OR linked_by = ?', args: [userId, userId] },
    ...snapshotLeftovers(),
    { sql: 'DELETE FROM note_collaborators WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)',
      args: [userId, userId] },
    { sql: 'DELETE FROM folder_collaborators WHERE user_id = ? OR folder_id IN (SELECT id FROM folders WHERE owner_id = ?)',
      args: [userId, userId] },
    { sql: 'UPDATE notes SET folder_id = NULL WHERE folder_id IN (SELECT id FROM folders WHERE owner_id = ?)', args: [userId] },
    { sql: 'UPDATE folders SET parent_id = NULL WHERE parent_id IN (SELECT id FROM folders WHERE owner_id = ?)', args: [userId] },
    { sql: 'DELETE FROM folders WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM notes WHERE owner_id = ?', args: [userId] },
    FOLDERS_CHANGED,
  ]);
}

async function exportUserData(ctx, userId) {
  const [notes, noteVersions, noteAssets, folders, noteCollaborators, folderCollaborators,
    tripLinks, tripSnapshots, tripSnapshotAssets, tripSnapshotVersions, tripNoteComments] = await Promise.all([
    ctx.db.query('SELECT * FROM notes WHERE owner_id = ?', userId),
    ctx.db.query('SELECT * FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', userId),
    ctx.db.query('SELECT * FROM note_assets WHERE owner_id = ?', userId),
    ctx.db.query('SELECT * FROM folders WHERE owner_id = ?', userId),
    ctx.db.query('SELECT * FROM note_collaborators WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)',
      userId, userId),
    ctx.db.query('SELECT * FROM folder_collaborators WHERE user_id = ? OR folder_id IN (SELECT id FROM folders WHERE owner_id = ?)',
      userId, userId),
    ctx.db.query('SELECT * FROM trip_note_links WHERE source_owner_id = ? OR linked_by = ?', userId, userId),
    ctx.db.query(`SELECT s.* FROM trip_note_snapshots s JOIN trip_note_links l USING (trip_id, note_id)
      WHERE l.source_owner_id = ? OR l.linked_by = ?`, userId, userId),
    ctx.db.query(`SELECT a.* FROM snapshot_assets a JOIN trip_note_links l USING (trip_id, note_id)
      WHERE l.source_owner_id = ? OR l.linked_by = ?`, userId, userId),
    ctx.db.query(`SELECT v.* FROM note_versions v JOIN trip_note_links l ON v.note_id = ${snapshotKeySql('l.')}
      WHERE l.mode = 'snapshot' AND (l.source_owner_id = ? OR l.linked_by = ?)`, userId, userId),
    ctx.db.query('SELECT * FROM trip_note_comments WHERE author_id = ?', userId),
  ]);
  return { notes, noteVersions, noteAssets, folders, noteCollaborators, folderCollaborators, tripLinks, tripSnapshots, tripSnapshotAssets,
    tripSnapshotVersions, tripComments: tripNoteComments };
}

const json = (status, value) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

// TREK's frame bridge hands the page only "Request failed with status code N", never the body, so an expected failure
// travels as a 200 envelope that the client turns back into a translated error. Crashes stay real 500s.
async function respond(fn) {
  try { return json(200, await fn()); }
  catch (error) {
    console.error('[Fieldnotes] request failed:', error instanceof Error ? error.stack : String(error));
    const problem = error instanceof Problem ? error
      : /RESOURCE_FORBIDDEN|PERMISSION_DENIED/.test(error?.message) ? new Problem(403, 'You do not have permission to do this.')
        // TREK caps how often a plugin may call it; the same request succeeds once the budget refills.
        : /rate limit exceeded/i.test(error?.message) ? new Problem(503, 'Fieldnotes is busy. Try again in a moment.')
        : error?.status >= 400 && error.status < 500 ? new Problem(error.status, String(error.message)) : null;
    if (!problem) return json(500, { error: 'Request failed. Try again or check the plugin logs.' });
    return json(200, { error: problem.message, status: problem.status, template: problem.template, params: problem.params });
  }
}

module.exports = { initialize, handle, tripAction, respond, deleteUserData, exportUserData };
