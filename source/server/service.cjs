'use strict';

const { randomUUID } = require('node:crypto');
const dns = require('node:dns/promises');
const https = require('node:https');
const { isIP } = require('node:net');
const { maxImageBytes, maxContentChars, maxContentBytes, maxPropertiesBytes } = require('../shared/limits.json');
const { createAssets } = require('./assets.cjs');
const { createCollab } = require('./collab.cjs');

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
const id = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) fail(400, 'Invalid note identifier.');
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
  const title = text(input.title, 160, 'title').trim();
  if (!title) fail(400, 'Title is required.');
  const content = text(input.content, maxContentChars, 'content');
  if (Buffer.byteLength(content, 'utf8') > maxContentBytes) fail(400, 'Content must fit within {size} KB.', { size: maxContentBytes / 1000 });
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
    if (value.length > 150000 || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value))
      fail(400, 'Note icon images must be PNG, JPEG, WebP or GIF under 100 KB.');
    return value;
  }
  const icon = value.trim();
  if (!icon || Array.from(icon).length > 16 || /[<>]/.test(icon)) fail(400, 'Invalid note icon.');
  return icon;
};
const PROPERTY_COLORS = 8;
const propertyValues = {
  text: (value) => text(value ?? '', 2000, 'text property'),
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
    const url = text(value ?? '', 2000, 'URL property').trim();
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
    if (!Array.isArray(value) || value.length > 50) fail(400, 'Use at most 50 checklist items.');
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
  if (!Array.isArray(raw) || raw.length > 30) fail(400, 'Use at most 30 properties.');
  const ids = new Set();
  const properties = raw.map((property) => {
    const pid = propertyId(property?.id);
    if (ids.has(pid)) fail(400, 'Duplicate property identifier.');
    ids.add(pid);
    const name = text(property.name, 40, 'property name').trim();
    if (!name) fail(400, 'Property name is required.');
    if (!Object.hasOwn(propertyValues, property.type)) fail(400, 'Invalid property type.');
    const choice = property.type === 'select' || property.type === 'multi_select';
    const options = choice ? propertyOptions(property.options) : [];
    return { id: pid, name, type: property.type, value: propertyValues[property.type](property.value, options),
      ...(choice ? { options } : {}) };
  });
  const json = JSON.stringify(properties);
  if (Buffer.byteLength(json, 'utf8') > maxPropertiesBytes) fail(400, 'Properties must fit within {size} KB.', { size: maxPropertiesBytes / 1000 });
  return json;
}
function propertyOptions(raw) {
  if (!Array.isArray(raw) || raw.length > 30) fail(400, 'Use at most 30 options per property.');
  return raw.map((option) => {
    const name = text(option?.name, 40, 'option name').trim();
    if (!name) fail(400, 'Option name is required.');
    if (!Number.isInteger(option.color) || option.color < 0 || option.color >= PROPERTY_COLORS) fail(400, 'Invalid option color.');
    return { id: propertyId(option.id), name, color: option.color };
  });
}
const parseList = (json) => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
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
const decode = (row) => {
  if (!row) return row;
  return { ...row, tags: parseList(row.tags), properties: parseList(row.properties ?? '[]'), visibility: row.visibility || 'private' };
};
const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
const tripFilePattern = /^fieldnotes:\/\/trip-file\/(\d+)\/(\d+)$/;
const pageSize = 7;
const noteSorts = { name: (a, b, collator) => collator.compare(a.title, b.title),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
  updated: (a, b) => a.updated_at.localeCompare(b.updated_at) };
const hostNotAllowed = 'Image host is not allowed. Paste the image itself, or ask an admin to allow this host.';
const maxSnapshotAssetsBytes = 32 * 1024 * 1024;
const maxSnapshotAssets = 100 - 2; // SDK transaction cap minus link and snapshot rows.
const allowedImageTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

function imageSources(content) {
  const sources = new Set();
  for (const match of String(content).matchAll(imagePattern)) sources.add(match[2]);
  return [...sources];
}

function tripFileSource(source) {
  const match = tripFilePattern.exec(source);
  return match ? { tripId: number(match[1]), fileId: number(match[2]) } : null;
}

function imageData(content, name = 'image') {
  const mimetype = String(content.mimetype || '').toLowerCase().split(';')[0];
  const size = Number(content.size || 0);
  if (!allowedImageTypes.has(mimetype) || !Number.isSafeInteger(size) || size > maxImageBytes
      || typeof content.content_base64 !== 'string' || content.content_base64.length > Math.ceil(maxImageBytes * 4 / 3)) {
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
  }
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
  await ctx.db.migrate('001_notes', `CREATE TABLE notes (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL, tags TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX notes_owner ON notes(owner_id, archived, updated_at);`);
  await ctx.db.migrate('002_note_visibility', "ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  await ctx.db.migrate('003_snapshot_assets', `CREATE TABLE snapshot_assets (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source TEXT NOT NULL,
    mimetype TEXT NOT NULL, size INTEGER NOT NULL, content_base64 TEXT NOT NULL,
    PRIMARY KEY (trip_id, note_id, source)
  );`);
  await ctx.db.migrate('004_note_collaborators', `CREATE TABLE note_collaborators (
    note_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (note_id, user_id)
  ); CREATE INDEX note_collaborators_user ON note_collaborators(user_id);`);
  await ctx.db.migrate('005_folders', `CREATE TABLE folders (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX folders_parent ON folders(parent_id, archived, name);
  CREATE TABLE folder_collaborators (
    folder_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL, PRIMARY KEY (folder_id, user_id)
  ); CREATE INDEX folder_collaborators_user ON folder_collaborators(user_id);
  ALTER TABLE notes ADD COLUMN folder_id TEXT;
  CREATE INDEX notes_folder ON notes(folder_id, archived, updated_at);`);
  await ctx.db.migrate('006_folder_icons', 'ALTER TABLE folders ADD COLUMN icon TEXT');
  await ctx.db.migrate('007_trip_folders', `CREATE TABLE trip_folders (
    id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, icon TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX trip_folders_trip ON trip_folders(trip_id, parent_id, archived, name);
  CREATE TABLE trip_note_folders (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, folder_id TEXT NOT NULL,
    PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX trip_note_folders_folder ON trip_note_folders(trip_id, folder_id);`);
  await ctx.db.migrate('008_trip_note_store', `CREATE TABLE IF NOT EXISTS trip_note_links (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, source_owner_id INTEGER NOT NULL, linked_by INTEGER,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'snapshot')), day_id INTEGER, linked_at TEXT NOT NULL,
    legacy_actor_unknown INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX IF NOT EXISTS trip_note_links_owner ON trip_note_links(source_owner_id, trip_id);
  CREATE INDEX IF NOT EXISTS trip_note_links_actor ON trip_note_links(linked_by, trip_id);
  CREATE TABLE IF NOT EXISTS trip_note_snapshots (
    trip_id INTEGER NOT NULL, note_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, visibility TEXT NOT NULL,
    captured_at TEXT NOT NULL, PRIMARY KEY (trip_id, note_id)
  ); CREATE INDEX IF NOT EXISTS trip_note_snapshots_captured ON trip_note_snapshots(trip_id, captured_at);
  CREATE INDEX IF NOT EXISTS snapshot_assets_note ON snapshot_assets(note_id, trip_id);`);
  await ctx.db.migrate('009_trip_note_intents', `CREATE TABLE trip_note_intents (
    owner_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, trip_folder_id TEXT, created_at TEXT NOT NULL
  );`);
  await ctx.db.migrate('010_note_properties', `ALTER TABLE notes ADD COLUMN properties TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE trip_note_snapshots ADD COLUMN properties TEXT NOT NULL DEFAULT '[]';`);
  await ctx.db.migrate('011_note_collab', `CREATE TABLE note_crdt (note_id TEXT PRIMARY KEY, state TEXT NOT NULL, seq INTEGER NOT NULL);
  CREATE TABLE note_updates (note_id TEXT NOT NULL, seq INTEGER NOT NULL, client_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (note_id, seq));
  CREATE TABLE note_presence (note_id TEXT NOT NULL, client_id INTEGER NOT NULL, user_id INTEGER NOT NULL, cursor TEXT, seen_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, client_id));`);
  await ctx.db.migrate('012_note_icons', 'ALTER TABLE notes ADD COLUMN icon TEXT; ALTER TABLE trip_note_snapshots ADD COLUMN icon TEXT;');
  await ctx.db.migrate('013_note_assets', `CREATE TABLE note_assets (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL,
    content_base64 TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
  ); CREATE INDEX note_assets_owner ON note_assets(owner_id);
  CREATE TABLE asset_uploads (
    id TEXT NOT NULL, owner_id INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL,
    data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, part)
  ); CREATE INDEX asset_uploads_created ON asset_uploads(created_at);`);
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

async function listAccessData(ctx, userId, includeNoteCollaborators = true) {
  const [folderRows, folderCollaboratorRows, noteCollaboratorRows] = await Promise.all([
    ctx.db.query(
      'SELECT id, owner_id, parent_id, name, icon, visibility, created_at, updated_at, archived FROM folders WHERE archived = 0'),
    ctx.db.query('SELECT folder_id, role FROM folder_collaborators WHERE user_id = ?', userId),
    includeNoteCollaborators ? ctx.db.query('SELECT note_id, role FROM note_collaborators WHERE user_id = ?', userId) : [],
  ]);
  return {
    folders: new Map(folderRows.map((folder) => [folder.id, folder])),
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

async function tripFolderList(ctx, tripId) {
  const trip = await checkTrip(ctx, tripId);
  const rows = await ctx.db.query(`SELECT id, trip_id, parent_id, name, icon, created_at, updated_at FROM trip_folders
    WHERE trip_id = ? AND archived = 0 ORDER BY parent_id, name, id`, trip.id);
  return rows.map((row) => ({ id: row.id, trip_id: row.trip_id, parent_id: row.parent_id, name: row.name, icon: row.icon || null,
    created_at: row.created_at, updated_at: row.updated_at, visibility: 'private', role: 'editor', public_path: true, can_manage: true }));
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

async function tripFolderAction(input, ctx) {
  const tripId = number(input.trip_id);
  await checkTrip(ctx, tripId);
  if (input.action === 'folders') return tripFolderList(ctx, tripId);
  if (['folder_create', 'folder_move', 'folder_parent', 'folder_icon', 'folder_archive'].includes(input.action))
    await requireTripEdit(ctx, tripId);
  if (input.action === 'folder_create') {
    const name = text(input.name, 80, 'folder name').trim();
    if (!name) fail(400, 'Folder name is required.');
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) {
      const [parent] = await ctx.db.query('SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', parentId, tripId);
      if (!parent) fail(404, 'Folder not found.');
    }
    const duplicate = parentId
      ? await ctx.db.query('SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id = ? AND name = ? AND archived = 0',
        tripId, parentId, name)
      : await ctx.db.query('SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id IS NULL AND name = ? AND archived = 0',
        tripId, name);
    if (duplicate.length) fail(409, 'A folder with this name already exists here.');
    const folderId = randomUUID(); const now = new Date().toISOString();
    const icon = input.icon ? text(input.icon, 8, 'folder icon').trim() : null;
    await ctx.db.exec(`INSERT INTO trip_folders (id, trip_id, parent_id, name, icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, folderId, tripId, parentId, name, icon, now, now);
    return (await tripFolderList(ctx, tripId)).find((folder) => folder.id === folderId);
  }
  if (input.action === 'folder_move') {
    const noteId = id(input.note_id);
    const [link] = await ctx.db.query('SELECT note_id FROM trip_note_links WHERE trip_id = ? AND note_id = ?', tripId, noteId);
    if (!link) fail(404, 'Linked note not found.');
    const targetId = input.folder_id ? id(input.folder_id) : null;
    if (targetId) {
      const [target] = await ctx.db.query('SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', targetId, tripId);
      if (!target) fail(404, 'Folder not found.');
      await ctx.db.exec('INSERT OR REPLACE INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)',
        tripId, noteId, targetId);
    } else {
      await ctx.db.exec('DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?', tripId, noteId);
    }
    return { moved: true, folder_id: targetId };
  }
  const folderId = id(input.folder_id);
  const [folder] = await ctx.db.query('SELECT * FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', folderId, tripId);
  if (!folder) fail(404, 'Folder not found.');
  if (input.action === 'folder_parent') {
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) {
      const [parent] = await ctx.db.query('SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', parentId, tripId);
      if (!parent) fail(404, 'Folder not found.');
    }
    await checkReparent(ctx, 'trip_folders', folder, parentId, { trip_id: tripId });
    await ctx.db.exec('UPDATE trip_folders SET parent_id = ?, updated_at = ? WHERE id = ?', parentId, new Date().toISOString(), folderId);
    return (await tripFolderList(ctx, tripId)).find((item) => item.id === folderId);
  }
  if (input.action === 'folder_icon') {
    const icon = input.icon ? text(input.icon, 8, 'folder icon').trim() : null;
    await ctx.db.exec('UPDATE trip_folders SET icon = ?, updated_at = ? WHERE id = ?', icon, new Date().toISOString(), folderId);
    return (await tripFolderList(ctx, tripId)).find((item) => item.id === folderId);
  }
  if (input.action === 'folder_archive') {
    const [child] = await ctx.db.query('SELECT id FROM trip_folders WHERE trip_id = ? AND parent_id = ? AND archived = 0 LIMIT 1',
      tripId, folderId);
    const [assignment] = await ctx.db.query('SELECT note_id FROM trip_note_folders WHERE trip_id = ? AND folder_id = ? LIMIT 1',
      tripId, folderId);
    if (child || assignment) fail(409, 'Move child folders and notes before deleting this folder.');
    await ctx.db.exec('UPDATE trip_folders SET archived = 1, updated_at = ? WHERE id = ?', new Date().toISOString(), folderId);
    return { archived: true };
  }
  fail(400, 'Unknown trip folder action.');
}

async function tripNotes(ctx, tripId, folderId = null) {
  const trip = await checkTrip(ctx, tripId);
  const links = await ctx.db.query(
    'SELECT note_id, source_owner_id, mode, day_id, linked_at FROM trip_note_links WHERE trip_id = ? ORDER BY linked_at, note_id',
    trip.id);
  if (!links.length) return { trip, notes: [] };
  const assignments = new Map((await ctx.db.query('SELECT note_id, folder_id FROM trip_note_folders WHERE trip_id = ?', trip.id))
    .map((row) => [row.note_id, row.folder_id]));
  const visibleLinks = folderId ? links.filter((link) => assignments.get(link.note_id) === folderId) : links;
  if (!visibleLinks.length) return { trip, notes: [] };
  const members = await ctx.trips.members(trip.id);
  const memberIds = new Set([trip.user_id, ...members.map((member) => member.id)]);
  const ids = visibleLinks.map((link) => link.note_id);
  const [rows, snapshots] = await Promise.all([
    ctx.db.query('SELECT * FROM notes WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)),
    ctx.db.query('SELECT * FROM trip_note_snapshots WHERE trip_id = ?', trip.id),
  ]);
  const notesById = new Map(rows.map((row) => [row.id, decode(row)]));
  const snapshotsById = new Map(snapshots.map((row) => [row.note_id, decode(row)]));
  const notes = visibleLinks.map((link) => {
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

function roleChanges(input) {
  if (!Array.isArray(input.changes) || input.changes.length > 100) fail(400, 'Invalid collaborator changes.');
  const seen = new Set();
  return input.changes.map((change) => {
    const userId = userNumber(change?.user_id);
    if (seen.has(userId) || !['editor', 'viewer'].includes(change?.role)) fail(400, 'Invalid collaborator changes.');
    seen.add(userId);
    return { userId, role: change.role };
  });
}

async function listFolders(ctx, userId) {
  const access = await listAccessData(ctx, userId, false);
  return [...access.folders.values()]
    .sort((a, b) => String(a.parent_id || '').localeCompare(String(b.parent_id || '')) || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id))
    .flatMap((row) => {
      const folderAccess = folderAccessFromRows(userId, row.id, access.folders, access.folderCollaborators);
      if (!folderAccess?.role) return [];
      return [{ id: row.id, owner_id: row.owner_id, parent_id: row.parent_id, name: row.name,
        icon: row.icon || null, visibility: row.visibility, role: folderAccess.role, created_at: row.created_at, updated_at: row.updated_at,
        public_path: folderAccess.publicPath, can_manage: row.owner_id === userId }];
    });
}

async function folderCollaborators(ctx, userId, folderId) {
  const [folder] = await ctx.db.query('SELECT * FROM folders WHERE id = ? AND archived = 0', id(folderId));
  if (!folder || folder.owner_id !== userId) fail(404, 'Folder not found.');
  const rows = await ctx.db.query(
    'SELECT user_id, role, created_at FROM folder_collaborators WHERE folder_id = ? ORDER BY created_at, user_id', folder.id);
  const candidates = await collaborationCandidates(ctx, userId);
  return { collaborators: rows.map((row) => ({ ...row, user: candidates.get(row.user_id) || { id: row.user_id } })),
    candidates: [...candidates.values()] };
}

async function folderAction(input, ctx, userId) {
  if (input.action === 'list') return listFolders(ctx, userId);
  if (input.action === 'create') {
    const name = text(input.name, 80, 'folder name').trim();
    if (!name) fail(400, 'Folder name is required.');
    if (!['private', 'public'].includes(input.visibility || 'private')) fail(400, 'Invalid folder visibility.');
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) await folderForWrite(ctx, userId, parentId);
    // Root folders only clash with the owner's own, so a name check never reveals another user's private folders.
    const duplicate = parentId
      ? await ctx.db.query('SELECT id FROM folders WHERE parent_id = ? AND name = ? AND archived = 0', parentId, name)
      : await ctx.db.query('SELECT id FROM folders WHERE parent_id IS NULL AND owner_id = ? AND name = ? AND archived = 0', userId, name);
    if (duplicate.length) fail(409, 'A folder with this name already exists here.');
    const folderId = randomUUID(); const now = new Date().toISOString();
    const icon = input.icon ? text(input.icon, 8, 'folder icon').trim() : null;
    await ctx.db.exec(`INSERT INTO folders (id, owner_id, parent_id, name, icon, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, folderId, userId, parentId, name, icon, input.visibility || 'private', now, now);
    return (await listFolders(ctx, userId)).find((folder) => folder.id === folderId);
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
  if (input.action === 'rename') {
    const name = text(input.name, 80, 'folder name').trim();
    if (!name) fail(400, 'Folder name is required.');
    const duplicate = await ctx.db.query('SELECT id FROM folders WHERE id != ? AND archived = 0 AND name = ? AND '
      + '(parent_id = ? OR (parent_id IS NULL AND ? IS NULL AND owner_id = ?))', folderId, name, folder.parent_id, folder.parent_id, userId);
    if (duplicate.length) fail(409, 'A folder with this name already exists here.');
    await ctx.db.exec('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?', name, new Date().toISOString(), folderId);
    return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
  }
  if (input.action === 'move') {
    const parentId = input.parent_id ? id(input.parent_id) : null;
    if (parentId) await folderForWrite(ctx, userId, parentId);
    await checkReparent(ctx, 'folders', folder, parentId, parentId ? {} : { owner_id: userId });
    await ctx.db.exec('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?', parentId, new Date().toISOString(), folderId);
    return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
  }
  if (input.action === 'visibility') {
    if (!['private', 'public'].includes(input.visibility)) fail(400, 'Invalid folder visibility.');
    await ctx.db.exec('UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ?',
      input.visibility, new Date().toISOString(), folderId);
    return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
  }
  if (input.action === 'icon') {
    const icon = input.icon ? text(input.icon, 8, 'folder icon').trim() : null;
    await ctx.db.exec('UPDATE folders SET icon = ?, updated_at = ? WHERE id = ?', icon, new Date().toISOString(), folderId);
    return (await listFolders(ctx, userId)).find((item) => item.id === folderId);
  }
  if (input.action === 'archive') {
    const [child] = await ctx.db.query('SELECT id FROM folders WHERE parent_id = ? AND archived = 0 LIMIT 1', folderId);
    const [note] = await ctx.db.query('SELECT id FROM notes WHERE folder_id = ? AND archived = 0 LIMIT 1', folderId);
    if (child || note) fail(409, 'Move child folders and notes before deleting this folder.');
    await ctx.db.exec('UPDATE folders SET archived = 1, updated_at = ? WHERE id = ?', new Date().toISOString(), folderId);
    return { archived: true };
  }
  if (input.action === 'collaborators') return folderCollaborators(ctx, userId, folderId);
  if (input.action === 'bulk_roles') {
    const changes = roleChanges(input);
    const candidates = await collaborationCandidates(ctx, userId);
    for (const change of changes) {
      if (change.userId === userId) fail(400, 'The folder owner is always an editor.');
      if (!candidates.has(change.userId)) fail(403, 'This user is not available for collaboration.');
    }
    await ctx.db.tx(changes.map((change) => ({
      sql: `INSERT INTO folder_collaborators (folder_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role`,
      args: [folderId, change.userId, change.role, new Date().toISOString()],
    })));
    return { saved: changes.length };
  }
  if (input.action === 'collaborator') {
    const targetId = userNumber(input.user_id);
    if (targetId === userId) fail(400, 'The folder owner is always an editor.');
    if (input.action !== 'collaborator' || !['editor', 'viewer'].includes(input.role)) fail(400, 'Choose a valid collaborator role.');
    const candidates = await collaborationCandidates(ctx, userId);
    if (!candidates.has(targetId)) fail(403, 'This user is not available for collaboration.');
    await ctx.db.exec(`INSERT INTO folder_collaborators (folder_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role`, folderId, targetId, input.role, new Date().toISOString());
    return { saved: true };
  }
  if (input.action === 'remove_collaborator') {
    await ctx.db.exec('DELETE FROM folder_collaborators WHERE folder_id = ? AND user_id = ?', folderId, userNumber(input.user_id));
    return { removed: true };
  }
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
  await owned(ctx, userId, noteId);
  const rows = await ctx.db.query(
    'SELECT user_id, role, created_at FROM note_collaborators WHERE note_id = ? ORDER BY created_at, user_id', id(noteId));
  const candidates = await collaborationCandidates(ctx, userId);
  return {
    collaborators: rows.map((row) => ({ ...row, user: candidates.get(row.user_id) || { id: row.user_id } })),
    candidates: [...candidates.values()],
  };
}

async function collaboratorAction(input, ctx, userId) {
  const noteId = id(input.note_id);
  await owned(ctx, userId, noteId);
  if (input.action === 'bulk_roles') {
    const changes = roleChanges(input);
    const candidates = await collaborationCandidates(ctx, userId);
    for (const change of changes) {
      if (change.userId === userId) fail(400, 'The note owner is always an editor.');
      if (!candidates.has(change.userId)) fail(403, 'This user is not available for collaboration.');
    }
    await ctx.db.tx(changes.map((change) => ({
      sql: `INSERT INTO note_collaborators (note_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role`,
      args: [noteId, change.userId, change.role, new Date().toISOString()],
    })));
    return { saved: changes.length };
  }
  const targetId = userNumber(input.user_id);
  if (targetId === userId) fail(400, 'The note owner is always an editor.');
  if (input.action === 'remove') {
    await ctx.db.exec('DELETE FROM note_collaborators WHERE note_id = ? AND user_id = ?', noteId, targetId);
    collab.forget(noteId);
    return { removed: true };
  }
  if (input.action !== 'add' || !['editor', 'viewer'].includes(input.role)) fail(400, 'Choose a valid collaborator role.');
  const candidates = await collaborationCandidates(ctx, userId);
  if (!candidates.has(targetId)) fail(403, 'This user is not available for collaboration.');
  await ctx.db.exec(`INSERT INTO note_collaborators (note_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role`, noteId, targetId, input.role, new Date().toISOString());
  return { saved: true };
}

async function noteForAsset(ctx, userId, noteId, tripId, source) {
  const note = tripId === null ? await readable(ctx, userId, noteId)
    : (await tripNotes(ctx, number(tripId))).notes.find((item) => item.id === id(noteId) && !item.unavailable);
  if (!note || !imageSources(note.content).includes(source)) fail(404, 'Image not found.');
  return note;
}

async function asset(ctx, userId, input) {
  const noteId = id(input.note_id);
  const source = text(input.source, 2048, 'image source');
  const tripId = input.trip_id === undefined || input.trip_id === null || input.trip_id === '' ? null : number(input.trip_id);
  await noteForAsset(ctx, userId, noteId, tripId, source);
  if (tripId !== null) {
    const [snapshot] = await ctx.db.query(
      'SELECT mimetype, size, content_base64 FROM snapshot_assets WHERE trip_id = ? AND note_id = ? AND source = ?',
      tripId, noteId, source,
    );
    if (snapshot) return { source, ...imageData(snapshot) };
  }
  const uploaded = await uploads.read(ctx, source);
  if (uploaded) return { source, ...imageData(uploaded, 'uploaded image') };
  const file = tripFileSource(source);
  if (file) return { source, ...imageData(await ctx.files.getContent(file.tripId, file.fileId), 'trip file') };
  if (/^https:\/\//i.test(source)) return { source, ...await fetchExternalImage(source) };
  fail(400, 'Unsupported image source.');
}

async function captureSnapshotAssets(ctx, note) {
  const sources = imageSources(note.content);
  if (sources.length > maxSnapshotAssets) fail(400, 'A snapshot can include at most {count} images.', { count: maxSnapshotAssets });
  const assets = []; let totalBytes = 0;
  for (const source of sources) {
    const file = tripFileSource(source);
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
    if (totalBytes > maxSnapshotAssetsBytes) fail(400, 'Snapshot images exceed the 32 MB limit.');
    assets.push({ source, ...image });
  }
  return assets;
}

async function beginTripNote(ctx, input) {
  const trip = await checkTrip(ctx, input.trip_id);
  await requireTripEdit(ctx, trip.id);
  const ownerId = number(input.actor_id);
  const members = await ctx.trips.members(trip.id);
  if (Number(trip.user_id) !== ownerId && !members.some((member) => Number(member.id) === ownerId)) fail(403, 'Trip member not found.');
  const tripFolderId = input.trip_folder_id ? id(input.trip_folder_id) : null;
  if (tripFolderId) {
    const [folder] = await ctx.db.query('SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', tripFolderId, trip.id);
    if (!folder) fail(404, 'Folder not found.');
  }
  await ctx.db.exec(`INSERT OR REPLACE INTO trip_note_intents (owner_id, trip_id, trip_folder_id, created_at)
    VALUES (?, ?, ?, ?)`, ownerId, trip.id, tripFolderId, new Date().toISOString());
  return { staged: true };
}

async function takeTripNoteIntent(ctx, userId) {
  const [intent] = await ctx.db.query('SELECT trip_id, trip_folder_id, created_at FROM trip_note_intents WHERE owner_id = ?', userId);
  if (!intent) return null;
  await ctx.db.exec('DELETE FROM trip_note_intents WHERE owner_id = ?', userId);
  if (Date.now() - Date.parse(intent.created_at) > 10 * 60 * 1000) return null;
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
  const tripFolderId = input.trip_folder_id ? id(input.trip_folder_id) : null;
  if (tripFolderId) {
    const [folder] = await ctx.db.query('SELECT id FROM trip_folders WHERE id = ? AND trip_id = ? AND archived = 0', tripFolderId, trip.id);
    if (!folder) fail(404, 'Folder not found.');
  }
  const noteId = randomUUID(); const now = new Date().toISOString();
  const ops = [
    {
      sql: `INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)`,
      args: [noteId, userId, title, content, tags ?? '[]', properties, icon, libraryFolderId, now, now],
    },
    {
      sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
        VALUES (?, ?, ?, ?, 'live', NULL, ?)`,
      args: [trip.id, noteId, userId, userId, now],
    },
  ];
  if (tripFolderId) ops.push({
    sql: 'INSERT INTO trip_note_folders (trip_id, note_id, folder_id) VALUES (?, ?, ?)',
    args: [trip.id, noteId, tripFolderId],
  });
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
  const [existing] = await ctx.db.query('SELECT note_id FROM trip_note_links WHERE trip_id = ? AND note_id = ?', trip.id, note.id);
  if (existing) fail(409, 'Already linked. Remove the existing link before replacing it.');
  const linkedAt = new Date().toISOString();
  const assets = input.mode === 'snapshot' ? await captureSnapshotAssets(ctx, note) : [];
  const ops = [{
    sql: `INSERT INTO trip_note_links (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [trip.id, note.id, note.owner_id, userId, input.mode, dayId, linkedAt],
  }];
  if (input.mode === 'snapshot') {
    ops.push({
      sql: `INSERT INTO trip_note_snapshots (trip_id, note_id, title, content, tags, properties, icon, version,
        updated_at, visibility, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [trip.id, note.id, note.title, note.content, JSON.stringify(note.tags), JSON.stringify(note.properties),
        note.icon ?? null, note.version, note.updated_at, note.visibility, linkedAt],
    });
    for (const asset of assets) {
      ops.push({
        sql: `INSERT INTO snapshot_assets (trip_id, note_id, source, mimetype, size, content_base64)
          VALUES (?, ?, ?, ?, ?, ?)`,
        args: [trip.id, note.id, asset.source, asset.mimetype, asset.size, asset.content_base64],
      });
    }
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

async function tripAction(input, ctx, authenticatedUserId = null) {
  if (input.action === 'links') {
    if (!Number.isSafeInteger(authenticatedUserId) || authenticatedUserId < 1) fail(401, 'Sign in first.');
    const noteId = id(input.note_id);
    await owned(ctx, authenticatedUserId, noteId);
    const accessibleTrips = await ctx.trips.listMine();
    const tripById = new Map(accessibleTrips.map((trip) => [Number(trip.id), trip]));
    const links = await ctx.db.query('SELECT trip_id, mode, day_id FROM trip_note_links WHERE note_id = ? ORDER BY trip_id', noteId);
    return links.flatMap((link) => {
      const trip = tripById.get(link.trip_id);
      return trip ? [{ id: link.trip_id, title: trip.title, mode: link.mode, day_id: link.day_id }] : [];
    });
  }
  const tripId = number(input.trip_id);
  if (['folders', 'folder_create', 'folder_icon', 'folder_archive', 'folder_move', 'folder_parent'].includes(input.action)) {
    return tripFolderAction(input, ctx);
  }
  if (input.action === 'list') return tripNotes(ctx, tripId, input.folder_id ? id(input.folder_id) : null);
  if (input.action === 'asset') return asset(ctx, null, input);
  if (input.action === 'begin_note') return beginTripNote(ctx, input);
  await checkTrip(ctx, tripId);
  if (input.action === 'days') return ctx.trips.getDays(tripId);
  if (input.action === 'can_edit') { await requireTripEdit(ctx, tripId); return { can_edit: true }; }
  if (input.action === 'unlink') {
    const noteId = id(input.note_id);
    await requireTripEdit(ctx, tripId);
    await ctx.db.tx([
      { sql: 'DELETE FROM trip_note_folders WHERE trip_id = ? AND note_id = ?', args: [tripId, noteId] },
      { sql: 'DELETE FROM snapshot_assets WHERE trip_id = ? AND note_id = ?', args: [tripId, noteId] },
      { sql: 'DELETE FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ?', args: [tripId, noteId] },
      { sql: 'DELETE FROM trip_note_links WHERE trip_id = ? AND note_id = ?', args: [tripId, noteId] },
    ]);
    return { removed: true };
  }
  if (input.action === 'excerpt') {
    const { notes } = await tripNotes(ctx, tripId);
    const note = notes.find((item) => item.id === id(input.note_id) && !item.unavailable);
    if (!note) fail(404, 'Linked note not found.');
    const dayId = await checkDay(ctx, tripId, input.day_id);
    if (!dayId) fail(400, 'Choose a day.');
    const excerpt = text(input.text, 500, 'excerpt').trim();
    if (!excerpt) fail(400, 'An excerpt is required.');
    return ctx.daynotes.create(tripId, dayId, { text: excerpt });
  }
  fail(400, 'Unknown action.');
}

async function folderPath(ctx, folderId) {
  const names = []; const seen = new Set(); let currentId = folderId;
  while (currentId) {
    if (seen.has(currentId) || names.length > 64) fail(409, 'Folder hierarchy is cyclic.');
    seen.add(currentId);
    const [folder] = await ctx.db.query('SELECT name, parent_id FROM folders WHERE id = ? AND archived = 0', currentId);
    if (!folder) return '';
    names.unshift(folder.name); currentId = folder.parent_id;
  }
  return names.join('/');
}

async function resolveReference(ctx, userId, reference, tripId = null) {
  const raw = text(reference, 300, 'reference').trim();
  const notePattern = /^fieldnotes:\/\/note\/([0-9a-f-]{36})$/i;
  if (tripId !== null) {
    const notes = (await tripNotes(ctx, number(tripId))).notes.filter((item) => !item.unavailable);
    const found = notes.find((item) => item.id === (raw.match(notePattern)?.[1] || raw)
      || item.title === raw || `${item.title}` === raw.split('/').at(-1));
    return found ? { reference: raw, id: found.id, title: found.title } : { reference: raw, unavailable: true };
  }
  if (notePattern.test(raw)) {
    try { const note = await readable(ctx, userId, raw.match(notePattern)[1]); return { reference: raw, id: note.id, title: note.title }; }
    catch { return { reference: raw, unavailable: true }; }
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
    return { reference: raw, id: row.id, title: row.title };
  }
  return { reference: raw, unavailable: true };
}

async function listNotes(ctx, userId, { search = '', offset = 0, publicOnly = false, folderId = null,
  sort = 'updated', order = 'desc', locale }) {
  const needle = search.toLocaleLowerCase();
  const matches = (note) => !needle || [note.title, note.content, note.tags.join('\n'), propertyText(note.properties)]
    .some((value) => value.toLocaleLowerCase().includes(needle));
  const [rows, access] = await Promise.all([
    ctx.db.query(`SELECT id, owner_id, title, content, tags, properties, icon, version,
      created_at, updated_at, visibility, folder_id FROM notes
      WHERE archived = 0 ORDER BY updated_at DESC, id`),
    listAccessData(ctx, userId, !publicOnly),
  ]);
  const visible = [];
  let skippedCount = 0;
  for (const row of rows) {
    if (folderId !== null && row.folder_id !== folderId) continue;
    if (!matches(decode(row))) continue;
    try {
      const noteAccess = noteAccessFromRows(userId, row, access);
      const listed = publicOnly
        ? row.visibility === 'public' && noteAccess.publicReadable
        : row.owner_id === userId || Boolean(noteAccess.directRole) || noteAccess.inheritedRole > 0;
      if (listed) visible.push(decode(row));
    } catch {
      skippedCount += 1;
    }
  }
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const direction = order === 'asc' ? 1 : -1;
  visible.sort((a, b) => direction * noteSorts[sort](a, b, collator) || a.id.localeCompare(b.id));
  return { notes: visible.slice(offset, offset + pageSize), has_more: visible.length > offset + pageSize, skipped_count: skippedCount };
}

const uploads = createAssets({ fail });
const collab = createCollab({ fail, id, editable, noteFields, propertyFields, noteIcon,
  referenceOps: uploads.referenceOps, sweep: uploads.sweep });

async function handle(action, req, ctx) {
  const userId = actor(req);
  const body = req.body || {};
  const query = req.query || {};
  if (action === 'trips') return ctx.trips.listMine();
  if (action === 'folders') return listFolders(ctx, userId);
  if (action === 'folder') return folderAction({ ...body, ...query }, ctx, userId);
  if (action === 'reference') return resolveReference(ctx, userId, query.ref, query.trip_id || null);
  if (action === 'asset') return asset(ctx, userId, query);
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
    const sort = query.sort || 'updated'; const order = query.order || 'desc';
    if (!Object.hasOwn(noteSorts, sort) || !['asc', 'desc'].includes(order)) fail(400, 'Invalid sort order.');
    let locale;
    try { [locale] = Intl.Collator.supportedLocalesOf(text(query.locale || 'en', 35, 'locale')); } catch { fail(400, 'Invalid locale.'); }
    return listNotes(ctx, userId, { search, offset, folderId, sort, order, locale, publicOnly: action === 'public' });
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
      const visibility = body.visibility || current.visibility;
      // Omitted tags or properties keep their stored value, so older callers never wipe them.
      const result = await ctx.db.exec(`UPDATE notes SET title = ?, content = ?, tags = COALESCE(?, tags),
        properties = COALESCE(?, properties),
        icon = CASE WHEN ? THEN ? ELSE icon END, visibility = ?, folder_id = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND archived = 0`,
      title, content, tags ?? null, properties ?? null, icon !== undefined ? 1 : 0, icon ?? null,
        visibility, folderId, now, current.id, body.version);
      if (result.changes !== 1) fail(409, 'This note changed. Reload before saving.');
      await uploads.track(ctx, current.content, content); await uploads.sweep(ctx);
      const saved = await readable(ctx, userId, current.id);
      await collab.external(ctx, saved);
      return saved;
    }
    const noteId = randomUUID();
    const visibility = body.visibility || 'private';
    const folderId = body.folder_id || null;
    if (folderId) await folderForWrite(ctx, userId, folderId);
    await ctx.db.exec(`INSERT INTO notes (id, owner_id, title, content, tags, properties, icon, visibility, folder_id, created_at,
      updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      noteId, userId, title, content, tags ?? '[]', properties ?? '[]', icon ?? null, visibility, folderId, now, now);
    await uploads.track(ctx, '', content);
    return owned(ctx, userId, noteId);
  }
  if (action === 'archive') {
    const current = await owned(ctx, userId, body.id);
    const result = await ctx.db.exec('UPDATE notes SET archived = 1, version = version + 1 WHERE id = ? AND owner_id = ? AND version = ?',
      body.id, userId, body.version);
    if (result.changes !== 1) fail(409, 'This note changed. Reload before deleting.');
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
    { sql: 'DELETE FROM note_assets WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM note_presence WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId, userId] },
    { sql: 'DELETE FROM note_updates WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId] },
    { sql: 'DELETE FROM note_crdt WHERE note_id IN (SELECT id FROM notes WHERE owner_id = ?)', args: [userId] },
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
    { sql: 'DELETE FROM note_collaborators WHERE user_id = ? OR note_id IN (SELECT id FROM notes WHERE owner_id = ?)',
      args: [userId, userId] },
    { sql: 'DELETE FROM folder_collaborators WHERE user_id = ? OR folder_id IN (SELECT id FROM folders WHERE owner_id = ?)',
      args: [userId, userId] },
    { sql: 'UPDATE notes SET folder_id = NULL WHERE folder_id IN (SELECT id FROM folders WHERE owner_id = ?)', args: [userId] },
    { sql: 'UPDATE folders SET parent_id = NULL WHERE parent_id IN (SELECT id FROM folders WHERE owner_id = ?)', args: [userId] },
    { sql: 'DELETE FROM folders WHERE owner_id = ?', args: [userId] },
    { sql: 'DELETE FROM notes WHERE owner_id = ?', args: [userId] },
  ]);
}

async function exportUserData(ctx, userId) {
  const [notes, noteAssets, folders, noteCollaborators, folderCollaborators,
    tripLinks, tripSnapshots, tripSnapshotAssets] = await Promise.all([
    ctx.db.query('SELECT * FROM notes WHERE owner_id = ?', userId),
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
  ]);
  return { notes, noteAssets, folders, noteCollaborators, folderCollaborators, tripLinks, tripSnapshots, tripSnapshotAssets };
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
        : error?.status >= 400 && error.status < 500 ? new Problem(error.status, String(error.message)) : null;
    if (!problem) return json(500, { error: 'Request failed. Try again or check the plugin logs.' });
    return json(200, { error: problem.message, status: problem.status, template: problem.template, params: problem.params });
  }
}

module.exports = { initialize, handle, tripAction, respond, deleteUserData, exportUserData };
