'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const dns = require('node:dns/promises');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const Y = require('yjs');
const { createMockHost } = require('trek-plugin-sdk');
const main = require('../server/index.js');
const companion = require('../server/trip.js');
const manifest = require('../fieldnotes.json');
const tripManifest = require('../fieldnotes-trip.json');

// Expected failures arrive as a 200 envelope (see respond in service.cjs); tests read the status it carries.
function outcome(result) {
  const data = JSON.parse(result.body);
  const envelope = result.status === 200 && typeof data?.error === 'string' && typeof data.status === 'number';
  return { status: envelope ? data.status : result.status, data };
}

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const metadata = new Map();
  const trips = {
    10: { members: [1, 2], data: { id: 10, user_id: 1, title: 'Japan' }, days: [{ id: 101, trip_id: 10 }],
      files: [{ id: 5, name: 'station.png', mimetype: 'image/png', content_base64: Buffer.from('png').toString('base64') }] },
    20: { members: [1], data: { id: 20, user_id: 1, title: 'Korea' }, days: [{ id: 201, trip_id: 20 }] },
    30: { members: [1, 3], data: { id: 30, user_id: 1, title: 'Taiwan' }, days: [{ id: 301, trip_id: 30 }] },
  };
  function host(userId, extra = {}) {
    const users = { 1: { id: 1, display_name: 'Tangerine' }, 2: { id: 2, username: 'sherwin' }, 3: { id: 3, username: 'matro' } };
    const h = createMockHost({ grants: manifest.permissions, actingUserId: userId, trips, users, ...extra });
    const base = h.ctx.db;
    const sql = {
      async query(query, ...args) { await base.query(query, ...args); return db.prepare(query).all(...args); },
      async exec(query, ...args) { await base.exec(query, ...args); return db.prepare(query).run(...args); },
      async tx(ops) {
        await base.tx(ops);
        db.exec('BEGIN IMMEDIATE');
        try {
          const results = ops.map((op, index) => {
            if (sql.failTxAt === index + 1) throw new Error('Injected transaction failure.');
            return { changes: db.prepare(op.sql).run(...(op.args || [])).changes };
          });
          db.exec('COMMIT');
          return { results };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      migrate(name, query) { return base.migrate(name, query).then((result) => { db.exec(query); return result; }); },
    };
    h.ctx.db = sql; h.userlessCtx.db = sql;
    const original = h.ctx.meta;
    h.ctx.meta = {
      async get(type, n, key) { await original.get(type, n, key); return metadata.get(`${n}:${key}`); },
      async set(type, n, key, value) {
        await original.set(type, n, key, value);
        // SDK 1.7's meta mock omits edit rights; mirror v4.3 MetaRpc.resolveEntity here.
        if ((extra.trips || trips)[n]?.canEditTrip === false) throw new Error('RESOURCE_FORBIDDEN: trip_edit required');
        metadata.set(`${n}:${key}`, value);
      },
      async delete(type, n, key) {
        await original.delete(type, n, key);
        if ((extra.trips || trips)[n]?.canEditTrip === false) throw new Error('RESOURCE_FORBIDDEN: trip_edit required');
        return { deleted: metadata.delete(`${n}:${key}`) };
      },
      async list(type, n) {
        await original.list(type, n);
        return Object.fromEntries([...metadata].filter(([key]) => key.startsWith(`${n}:`)).map(([key, value]) =>
          [key.slice(String(n).length + 1), value]));
      },
    };
    const app = h.run(main);
    h.request = async (method, path, body = {}, query = {}) => {
      return outcome(await app.route({ method, path }, { body, query }));
    };
    return h;
  }
  const owner = host(1);
  await owner.run(main).load();
  return { db, host, owner, metadata };
}
const create = async (owner, fields = {}) => {
  const res = await owner.request('POST', '/save', { title: 'Japan transport', content: '# IC card\nKeep a spare.', tags: ['Japan'],
    ...fields });
  assert.equal(res.status, 200, JSON.stringify(res)); return res.data;
};
const link = (owner, note, trip = 10, mode = 'live', day = null) => owner.request('POST', '/link',
  { note_id: note.id, trip_id: trip, mode, day_id: day });
const readTrip = async (h, trip = 10) => h.request('POST', '/trip', { action: 'list', trip_id: trip });

test('entrypoint creates schema and authenticated route persists a private note', async (t) => {
  const { owner, host } = await setup(t);
  const note = await create(owner, { owner_id: 2 });
  assert.equal(note.owner_id, 1);
  assert.equal((await owner.request('GET', '/notes')).data.notes.length, 1);
  assert.equal((await host(2).request('GET', '/notes')).data.notes.length, 0);
  assert.equal((await host(2).request('GET', '/note', {}, { id: note.id })).status, 404);
  assert.equal((await host(undefined).request('GET', '/notes')).status, 401);
});

test('public notes are readable without exposing private notes', async (t) => {
  const { owner, host } = await setup(t);
  const privateNote = await create(owner);
  const publicNote = await create(owner, { visibility: 'public', title: 'Public trains' });
  assert.equal((await host(2).request('GET', '/note', {}, { id: privateNote.id })).status, 404);
  assert.equal((await host(2).request('GET', '/note', {}, { id: publicNote.id })).status, 200);
  assert.equal((await host(2).request('GET', '/public')).data.notes[0].id, publicNote.id);
  await link(owner, publicNote);
  assert.equal((await readTrip(host(2))).data.notes[0].id, publicNote.id);
});

test('image resources enforce note, source-trip and snapshot permissions', async (t) => {
  const { owner, host } = await setup(t);
  const source = 'fieldnotes://trip-file/10/5';
  const note = await create(owner, { content: `![station](${source})` });
  const ownerImage = await owner.request('GET', '/asset', {}, { note_id: note.id, source });
  assert.equal(ownerImage.status, 200); assert.match(ownerImage.data.data_url, /^data:image\/png;base64,/);
  await link(owner, note);
  const live = await host(2).request('GET', '/asset', {}, { note_id: note.id, trip_id: 10, source });
  assert.equal(live.status, 200); assert.match(live.data.data_url, /^data:image\/png;base64,/);
  assert.equal((await host(3).request('GET', '/asset', {}, { note_id: note.id, trip_id: 10, source })).status, 403);
  assert.equal((await link(owner, note, 20, 'snapshot')).status, 200);
  const frozen = await owner.request('GET', '/asset', {}, { note_id: note.id, trip_id: 20, source });
  assert.equal(frozen.status, 200); assert.match(frozen.data.data_url, /^data:image\/png;base64,/);
});

test('snapshot link, content and image persist as one transaction', async (t) => {
  const { owner, db } = await setup(t);
  const source = 'fieldnotes://trip-file/10/5';
  const note = await create(owner, { content: `![station](${source})` });
  owner.ctx.db.failTxAt = 3;
  assert.equal((await link(owner, note, 10, 'snapshot')).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_links').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_snapshots').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshot_assets').get().count, 0);
  owner.ctx.db.failTxAt = null;
  assert.equal((await link(owner, note, 10, 'snapshot')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_links').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_snapshots').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshot_assets').get().count, 1);
});

test('external image fetch pins checked DNS addresses through redirects and caps streamed bytes', async (t) => {
  const { owner, db } = await setup(t);
  const frozen = (note) => db.prepare('SELECT COUNT(*) AS count FROM snapshot_assets WHERE note_id = ?').get(note.id).count;
  // Unfetchable images are left out of the snapshot instead of blocking it.
  const snapshotWithout = async (note, trip) => { assert.equal((await link(owner, note, trip, 'snapshot')).status, 200);
    assert.equal(frozen(note), 0); };
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  const image = await create(owner, { content: '![image](https://images.example.test/picture.png)' });
  const requests = []; let resolutions = 0;
  const publicAddress = [{ address: '93.184.216.34', family: 4 }];
  const installResponse = (makeResponse) => {
    https.request = (url, options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const respond = (pinnedAddresses) => {
          requests.push({ hostname: url.hostname, pinnedAddresses, servername: options.servername, agent: options.agent });
          queueMicrotask(() => callback(makeResponse(url)));
        };
        if (options.lookup) {
          options.lookup(url.hostname, { all: true }, (error, addresses) => {
            if (error) request.emit('error', error);
            else respond(addresses);
          });
        } else respond(null);
      };
      return request;
    };
  };
  try {
    installResponse(() => {
      const response = Readable.from([Buffer.from('png')]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png' };
      return response;
    });
    dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await snapshotWithout(await create(owner, { title: 'Loopback', content: image.content }), 10);
    dns.lookup = async () => [{ address: '2002::1', family: 6 }];
    await snapshotWithout(await create(owner, { title: '6to4', content: image.content }), 10);
    assert.equal(requests.length, 0);

    dns.lookup = async (hostname) => {
      if (hostname === 'inside.example.test') return [{ address: '169.254.169.254', family: 4 }];
      resolutions += 1;
      return resolutions === 1 ? publicAddress : [{ address: '169.254.169.254', family: 4 }];
    };
    installResponse(() => {
      const response = Readable.from([Buffer.from('png')]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png', 'content-length': '3' };
      return response;
    });
    assert.equal((await link(owner, image, 10, 'snapshot')).status, 200);
    assert.equal(frozen(image), 1);
    assert.deepEqual(requests[0].pinnedAddresses, publicAddress);
    assert.equal(requests[0].servername, 'images.example.test');
    assert.equal(requests[0].agent, false);
    assert.equal(resolutions, 1);

    const redirectImage = await create(owner, { title: 'Redirect image', content: image.content });
    resolutions = 0;
    installResponse(() => {
      const response = Readable.from([]);
      response.statusCode = 302;
      response.headers = { location: 'https://inside.example.test/private.png' };
      return response;
    });
    const lookupsBeforeRedirect = requests.length;
    await snapshotWithout(redirectImage, 20);
    assert.equal(requests.length, lookupsBeforeRedirect + 1);
    assert.equal(resolutions, 1);

    const largeImage = await create(owner, { title: 'Large image', content: image.content });
    resolutions = 0;
    installResponse(() => {
      const response = Readable.from([Buffer.alloc(4 * 1024 * 1024), Buffer.alloc(1)]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png' };
      return response;
    });
    await snapshotWithout(largeImage, 30);
    assert.equal(resolutions, 1);
  } finally {
    dns.lookup = originalLookup;
    https.request = originalRequest;
  }
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]).toString('base64');
async function upload(h, data = png) {
  const first = await h.request('POST', '/upload', { part: 0, parts: 2, data: data.slice(0, 16) });
  assert.equal(first.status, 200, JSON.stringify(first));
  return h.request('POST', '/upload', { upload_id: first.data.upload_id, part: 1, parts: 2, data: data.slice(16) });
}
const age = (db, column, assetId, ms) =>
  db.prepare(`UPDATE note_assets SET ${column} = ? WHERE id = ?`).run(new Date(Date.now() - ms).toISOString(), assetId);
const assetCount = (db) => db.prepare('SELECT COUNT(*) AS count FROM note_assets').get().count;

test('uploaded images assemble from ordered parts and are served only through notes that contain them', async (t) => {
  const { owner, host, db } = await setup(t);
  assert.equal((await owner.request('POST', '/upload',
    { part: 1, parts: 2, data: png.slice(16), upload_id: '00000000-0000-4000-8000-000000000000' })).status, 409);
  assert.equal((await owner.request('POST', '/upload', { part: 0, parts: 1, data: 'not base64!' })).status, 400);
  assert.equal((await owner.request('POST', '/upload', { part: 0, parts: 1, data: Buffer.from('<svg/>').toString('base64') })).status, 415);
  const first = await owner.request('POST', '/upload', { part: 0, parts: 2, data: png.slice(0, 16) });
  assert.equal((await host(2).request('POST', '/upload', { upload_id: first.data.upload_id, part: 1, parts: 2,
    data: png.slice(16) })).status, 409);
  const uploaded = await owner.request('POST', '/upload', { upload_id: first.data.upload_id, part: 1, parts: 2, data: png.slice(16) });
  assert.equal(uploaded.status, 200); assert.equal(uploaded.data.mimetype, 'image/png'); assert.equal(uploaded.data.size, 24);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM asset_uploads').get().count, 0);
  const { source } = uploaded.data;
  const note = await create(owner, { content: `![photo](${source})` });
  const own = await owner.request('GET', '/asset', {}, { note_id: note.id, source });
  assert.equal(own.data.data_url, `data:image/png;base64,${png}`);
  assert.equal((await host(2).request('GET', '/asset', {}, { note_id: note.id, source })).status, 404);
  const other = await create(host(2), { title: 'Borrowed', content: 'no image' });
  assert.equal((await host(2).request('GET', '/asset', {}, { note_id: other.id, source })).status, 404);
  await link(owner, note);
  assert.equal((await host(2).request('GET', '/asset', {}, { note_id: note.id, trip_id: 10, source })).status, 200);
  assert.equal((await link(owner, note, 20, 'snapshot')).status, 200);
  assert.equal(db.prepare('SELECT content_base64 FROM snapshot_assets WHERE source = ?').get(source).content_base64, png);
});

test('images removed from a note are deleted after a grace window, unless used again or kept by a snapshot', async (t) => {
  const { owner, db } = await setup(t);
  const kept = (await upload(owner)).data.source; const dropped = (await upload(owner)).data.source;
  const keptId = kept.split('/').pop(); const droppedId = dropped.split('/').pop();
  let note = await create(owner, { content: `![a](${kept})\n![b](${dropped})` });
  await link(owner, note, 20, 'snapshot');
  note = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: note.title, content: `![a](${kept})` })).data;
  assert.ok(db.prepare('SELECT released_at FROM note_assets WHERE id = ?').get(droppedId).released_at);
  assert.equal(db.prepare('SELECT released_at FROM note_assets WHERE id = ?').get(keptId).released_at, null);
  // Undo inside the grace window restores the image; removing it again restarts the window.
  note = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: note.title,
    content: `![a](${kept})\n![b](${dropped})` })).data;
  assert.equal(db.prepare('SELECT released_at FROM note_assets WHERE id = ?').get(droppedId).released_at, null);
  note = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: note.title, content: `![a](${kept})` })).data;
  assert.equal(assetCount(db), 2);
  age(db, 'released_at', droppedId, 11 * 60 * 1000);
  note = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: note.title,
    content: `![a](${kept}) again` })).data;
  assert.deepEqual(db.prepare('SELECT id FROM note_assets').all().map((row) => row.id), [keptId]);
  assert.equal((await owner.request('GET', '/asset', {}, { note_id: note.id, trip_id: 20, source: dropped })).status, 200);
  // Deleting the note releases its images too.
  assert.equal((await owner.request('POST', '/archive', { id: note.id, version: note.version })).status, 200);
  age(db, 'released_at', keptId, 11 * 60 * 1000);
  await upload(owner);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE id = ?').get(keptId).count, 0);
});

test('uploads never saved into a note survive a day of drafting, then are deleted', async (t) => {
  const { owner, db } = await setup(t);
  const draft = (await upload(owner)).data.source.split('/').pop();
  const stale = (await upload(owner)).data.source.split('/').pop();
  age(db, 'created_at', stale, 25 * 60 * 60 * 1000); age(db, 'created_at', draft, 23 * 60 * 60 * 1000);
  await upload(owner);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE id = ?').get(stale).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE id = ?').get(draft).count, 1);
});

test('co-editing releases images removed from the shared document', async (t) => {
  const { owner, db } = await setup(t);
  const { source } = (await upload(owner)).data;
  const note = await create(owner, { content: `Map\n![map](${source})` });
  const client = await collabClient(owner, note.id);
  const content = client.doc.getText('content'); content.delete(3, content.length - 3);
  assert.equal((await client.sync()).status, 200);
  assert.ok(db.prepare('SELECT released_at FROM note_assets').get().released_at);
  content.insert(3, `\n![map](${source})`); await client.sync();
  assert.equal(db.prepare('SELECT released_at FROM note_assets').get().released_at, null);
});

test('external images outside the plugin egress list explain why they cannot load and never block a snapshot', async (t) => {
  const { owner } = await setup(t);
  const originalLookup = dns.lookup;
  dns.lookup = async (hostname) => { throw new Error(`egress: DNS lookup for ${hostname} is not in the plugin's declared hosts`); };
  try {
    const note = await create(owner, { content: '![view](https://images.example.test/view.jpg)' });
    const result = await owner.request('GET', '/asset', {}, { note_id: note.id, source: 'https://images.example.test/view.jpg' });
    assert.equal(result.status, 403); assert.match(result.data.error, /host is not allowed/);
    assert.equal((await link(owner, note, 10, 'snapshot')).status, 200);
    const frozen = await owner.request('GET', '/asset', {},
      { note_id: note.id, trip_id: 10, source: 'https://images.example.test/view.jpg' });
    assert.equal(frozen.status, 403);
  } finally { dns.lookup = originalLookup; }
});

test('uploads stop once stored images and snapshot copies fill their share of the plugin database', async (t) => {
  const { owner, host, db } = await setup(t);
  db.prepare(`INSERT INTO snapshot_assets (trip_id, note_id, source, mimetype, size, content_base64)
    VALUES (10, '00000000-0000-4000-8000-000000000000', 'x', 'image/png', ?, '')`).run(96 * 1024 * 1024 - 20);
  assert.equal((await upload(host(2))).status, 413);
  // The refused upload left its first part behind; unfinished parts count too, so they cannot fill the database.
  assert.equal((await host(2).request('POST', '/upload', { part: 0, parts: 2, data: png.slice(0, 16) })).status, 413);
  db.prepare('UPDATE snapshot_assets SET size = size - 24').run();
  assert.equal((await upload(owner)).status, 200);
});

test('user erasure and export include uploaded images', async (t) => {
  const { owner, host, db } = await setup(t);
  const { source } = (await upload(owner)).data; await upload(host(2));
  await create(owner, { content: `![photo](${source})` });
  assert.equal((await owner.run(main).exportUserData(1)).noteAssets.length, 1);
  await owner.run(main).deleteUserData(1);
  assert.deepEqual(db.prepare('SELECT owner_id FROM note_assets').all().map((row) => row.owner_id), [2]);
});

test('expected failures reach the page as a translatable 200 envelope; crashes stay 500', async (t) => {
  const { owner } = await setup(t);
  const app = owner.run(main);
  const invalid = await app.route({ method: 'POST', path: '/save' }, { body: { title: 'x'.repeat(161), content: '' } });
  assert.equal(invalid.status, 200);
  assert.deepEqual(JSON.parse(invalid.body), { error: 'Invalid value: title.', status: 400, template: 'Invalid value: {field}.', params: { field: 'title' } });
  owner.ctx.db.failTxAt = 1;
  const crashed = await app.route({ method: 'POST', path: '/collaborator' },
    { body: { action: 'bulk_roles', note_id: (await create(owner)).id, changes: [{ user_id: 2, role: 'editor' }] } });
  assert.equal(crashed.status, 500); assert.equal(JSON.parse(crashed.body).template, undefined);
});

test('private notes support explicit editors without granting sharing control', async (t) => {
  const { owner, host } = await setup(t);
  const note = await create(owner);
  const people = await owner.request('GET', '/collaborators', {}, { note_id: note.id });
  assert.equal(people.status, 200); assert.ok(people.data.candidates.some((person) => person.id === 2));
  assert.equal((await owner.request('POST', '/collaborator', { action: 'add', note_id: note.id, user_id: 2, role: 'editor' })).status, 200);
  const editor = host(2);
  const readableNote = await editor.request('GET', '/note', {}, { id: note.id });
  assert.equal(readableNote.status, 200); assert.equal(readableNote.data.can_edit, true);
  const changed = await editor.request('POST', '/save', { ...note, title: 'Edited together' });
  assert.equal(changed.status, 200); assert.equal(changed.data.title, 'Edited together');
  assert.equal((await owner.request('POST', '/collaborator', { action: 'add', note_id: note.id, user_id: 2, role: 'viewer' })).status, 200);
  assert.equal((await owner.request('POST', '/collaborator',
    { action: 'bulk_roles', note_id: note.id, changes: [{ user_id: 2, role: 'editor' }] })).status, 200);
  const bulkEdited = await editor.request('POST', '/save', { ...changed.data, title: 'Bulk role update works' });
  assert.equal(bulkEdited.status, 200);
  assert.equal((await owner.request('POST', '/collaborator',
    { action: 'bulk_roles', note_id: note.id, changes: [{ user_id: 2, role: 'viewer' }] })).status, 200);
  assert.equal((await editor.request('POST', '/save', { ...bulkEdited.data, title: 'Should fail' })).status, 403);
  assert.equal((await editor.request('POST', '/collaborator', { action: 'add', note_id: note.id, user_id: 1,
    role: 'viewer' })).status, 404);
  assert.equal((await owner.request('POST', '/collaborator', { action: 'remove', note_id: note.id, user_id: 2 })).status, 200);
  assert.equal((await editor.request('GET', '/note', {}, { id: note.id })).status, 404);
});

test('bulk collaborator role updates commit atomically for notes and folders', async (t) => {
  const { owner, db } = await setup(t);
  const note = await create(owner);
  const changes = [{ user_id: 2, role: 'editor' }, { user_id: 3, role: 'viewer' }];

  owner.ctx.db.failTxAt = 2;
  assert.equal((await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes })).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_collaborators WHERE note_id = ?').get(note.id).count, 0);

  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Shared' })).data;
  assert.equal((await owner.request('POST', '/folder', { action: 'bulk_roles', folder_id: folder.id, changes })).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM folder_collaborators WHERE folder_id = ?').get(folder.id).count, 0);

  delete owner.ctx.db.failTxAt;
  assert.equal((await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_collaborators WHERE note_id = ?').get(note.id).count, 2);
});

test('folder permissions inherit without allowing public visibility to bypass private ancestors', async (t) => {
  const { owner, host } = await setup(t);
  const root = (await owner.request('POST', '/folder', { action: 'create', name: 'Japan', visibility: 'private' })).data;
  const child = (await owner.request('POST', '/folder', { action: 'create', name: 'Transport', parent_id: root.id,
    visibility: 'public' })).data;
  const note = await create(owner, { folder_id: child.id });
  assert.equal((await owner.request('POST', '/folder', { action: 'collaborator', folder_id: root.id, user_id: 2,
    role: 'viewer' })).status, 200);
  const viewer = host(2);
  assert.equal((await viewer.request('GET', '/folders')).data.find((folder) => folder.id === child.id).role, 'viewer');
  assert.equal((await viewer.request('GET', '/note', {}, { id: note.id })).data.can_edit, false);
  assert.equal((await viewer.request('POST', '/save', { ...note, title: 'No edit yet' })).status, 403);
  await owner.request('POST', '/folder', { action: 'collaborator', folder_id: root.id, user_id: 2, role: 'editor' });
  assert.equal((await owner.request('POST', '/folder',
    { action: 'bulk_roles', folder_id: root.id, changes: [{ user_id: 2, role: 'viewer' }] })).status, 200);
  assert.equal((await viewer.request('POST', '/save', { ...note, title: 'Viewer cannot edit' })).status, 403);
  assert.equal((await owner.request('POST', '/folder',
    { action: 'bulk_roles', folder_id: root.id, changes: [{ user_id: 2, role: 'editor' }] })).status, 200);
  assert.equal((await viewer.request('POST', '/save', { ...note, title: 'Edited through folder' })).status, 200);

  const publicRoot = (await owner.request('POST', '/folder', { action: 'create', name: 'Public', visibility: 'public' })).data;
  const privateInPublic = await create(owner, { folder_id: publicRoot.id, title: 'Private in public folder' });
  assert.equal((await viewer.request('GET', '/note', {}, { id: privateInPublic.id })).status, 404);
  const privateChild = (await owner.request('POST', '/folder', { action: 'create', name: 'Private', parent_id: publicRoot.id,
    visibility: 'private' })).data;
  const hiddenPublicNote = await create(owner, { folder_id: privateChild.id, visibility: 'public', title: 'Hidden public note' });
  assert.equal((await viewer.request('GET', '/public')).data.notes.some((item) => item.id === hiddenPublicNote.id), false);
  const reference = await owner.request('GET', '/reference', {}, { ref: `fieldnotes://note/${note.id}` });
  assert.deepEqual(reference.data, { reference: `fieldnotes://note/${note.id}`, id: note.id, title: 'Edited through folder' });
  assert.equal((await viewer.request('GET', '/reference', {}, { ref: `fieldnotes://note/${hiddenPublicNote.id}` })).data.unavailable, true);
});

test('notes can be moved between owned folders without replacing their content', async (t) => {
  const { owner } = await setup(t); const source = (await owner.request('POST', '/folder', { action: 'create', name: 'Source' })).data;
  const target = (await owner.request('POST', '/folder', { action: 'create', name: 'Target' })).data;
  const note = await create(owner, { folder_id: source.id });
  const moved = await owner.request('POST', '/folder', { action: 'move_note', note_id: note.id, folder_id: target.id });
  assert.equal(moved.status, 200); assert.equal(moved.data.id, note.id); assert.equal(moved.data.content, note.content);
  assert.equal(moved.data.folder_id, target.id);
});

test('sharing control stays with the owner: collaborators cannot move, re-scope or live-share a private note', async (t) => {
  const { owner, host } = await setup(t);
  const shared = (await owner.request('POST', '/folder', { action: 'create', name: 'Shared' })).data;
  const note = await create(owner, { folder_id: shared.id });
  await owner.request('POST', '/collaborator', { action: 'add', note_id: note.id, user_id: 2, role: 'editor' });
  const editor = host(2);
  // Root folder names are per owner: the same name neither clashes with nor reveals another user's private folder.
  const own = await editor.request('POST', '/folder', { action: 'create', name: 'Shared' });
  assert.equal(own.status, 200);
  assert.equal((await editor.request('POST', '/folder', { action: 'move_note', note_id: note.id, folder_id: own.data.id })).status, 403);
  assert.equal((await editor.request('POST', '/save', { ...note, folder_id: own.data.id })).status, 403);
  const saved = await editor.request('POST', '/save', { ...note, title: 'Edited in place' });
  assert.equal(saved.status, 200); assert.equal(saved.data.folder_id, shared.id);
  assert.equal((await link(editor, note)).status, 403);
  assert.equal((await link(editor, note, 10, 'snapshot')).status, 200);
  const published = await create(owner, { title: 'Published', visibility: 'public' });
  assert.equal((await link(editor, published)).status, 200);
});

test('folders can be reparented without cycles or name clashes', async (t) => {
  const { owner, host } = await setup(t);
  const folder = async (name, parent_id = null) => (await owner.request('POST', '/folder', { action: 'create', name, parent_id })).data;
  const move = (folder_id, parent_id, h = owner) => h.request('POST', '/folder', { action: 'move', folder_id, parent_id });
  const japan = await folder('日本'); const korea = await folder('韩国'); const transport = await folder('交通', japan.id);
  assert.equal((await move(transport.id, korea.id)).data.parent_id, korea.id);
  assert.equal((await move(korea.id, transport.id)).status, 409);
  assert.equal((await move(korea.id, korea.id)).status, 409);
  await folder('交通', japan.id);
  assert.equal((await move(transport.id, japan.id)).status, 409);
  assert.equal((await move(transport.id, korea.id, host(2))).status, 404);
  assert.equal((await move(transport.id, null)).data.parent_id, null);
  const listed = (await owner.request('GET', '/folders')).data.find((item) => item.id === transport.id);
  assert.equal(listed.parent_id, null); assert.ok(listed.created_at && listed.updated_at);
});

test('note listing sorts by name, creation or modification across pages', async (t) => {
  const { owner, db } = await setup(t);
  for (const [title, created, updated] of [['Day 10', '2026-01-03', '2026-01-04'], ['Day 2', '2026-01-02', '2026-01-06'],
    ['day 1', '2026-01-01', '2026-01-05']]) {
    const note = await create(owner, { title });
    db.prepare('UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?').run(created, updated, note.id);
  }
  const titles = async (query) => (await owner.request('GET', '/notes', {}, query)).data.notes.map((item) => item.title);
  assert.deepEqual(await titles({}), ['Day 2', 'day 1', 'Day 10']);
  assert.deepEqual(await titles({ sort: 'name', order: 'asc' }), ['day 1', 'Day 2', 'Day 10']);
  assert.deepEqual(await titles({ sort: 'created', order: 'desc' }), ['Day 10', 'Day 2', 'day 1']);
  assert.equal((await owner.request('GET', '/notes', {}, { sort: 'title' })).status, 400);
  assert.equal((await owner.request('GET', '/notes', {}, { sort: 'name', locale: 'not a locale!' })).status, 400);
});

// A test client that speaks the /collab protocol with a real Yjs document.
async function collabClient(h, noteId) {
  const doc = new Y.Doc(); const pending = []; let seq = -1;
  doc.on('update', (update, origin) => { if (origin !== 'remote') pending.push(update); });
  const apply = (data) => {
    if (data.state) Y.applyUpdate(doc, Buffer.from(data.state, 'base64'), 'remote');
    for (const update of data.updates) Y.applyUpdate(doc, Buffer.from(update, 'base64'), 'remote');
    seq = data.seq; return data;
  };
  const joined = await h.request('POST', '/collab', { action: 'join', note_id: noteId, client_id: doc.clientID });
  if (joined.status !== 200) return { status: joined.status };
  apply(joined.data);
  return {
    doc, joined: joined.data, text: () => doc.getText('content').toString(),
    async sync(cursor = null) {
      const updates = pending.splice(0).map((update) => Buffer.from(update).toString('base64'));
      const result = await h.request('POST', '/collab', { action: 'sync', note_id: noteId, client_id: doc.clientID, since: seq,
        updates, cursor });
      return result.status === 200 ? { status: 200, ...apply(result.data) } : result;
    },
  };
}

test('collaborators co-edit one Yjs document that materializes into the note', async (t) => {
  const { owner, host, db } = await setup(t); const note = await create(owner, { content: 'Suica' });
  await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes: [{ user_id: 2, role: 'editor' }] });
  const a = await collabClient(owner, note.id); const b = await collabClient(host(2), note.id);
  assert.equal(a.text(), 'Suica'); assert.equal(b.text(), 'Suica');
  assert.deepEqual(a.joined.me, { name: 'Tangerine', color: a.joined.me.color });
  a.doc.getText('content').insert(0, 'Buy '); b.doc.getText('content').insert(5, ' today');
  await a.sync({ anchor: 'a' }); await b.sync({ anchor: 'b' }); const seen = await a.sync();
  assert.equal(a.text(), 'Buy Suica today'); assert.equal(b.text(), 'Buy Suica today');
  assert.deepEqual(seen.presence.map((person) => [person.user_id, person.name, person.cursor]), [[2, 'sherwin', { anchor: 'b' }]]);
  const stored = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  assert.equal(stored.content, 'Buy Suica today'); assert.ok(stored.version > note.version);
  // Properties merge per property; a later plain save reaches open sessions as one more update.
  b.doc.getMap('properties').set('fare', { id: 'fare', name: 'Fare', type: 'number', value: 170, position: 0 }); await b.sync();
  const fresh = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  assert.deepEqual(fresh.properties, [{ id: 'fare', name: 'Fare', type: 'number', value: 170 }]);
  await owner.request('POST', '/save', { id: fresh.id, version: fresh.version, title: fresh.title, content: 'Saved elsewhere' });
  await a.sync(); assert.equal(a.text(), 'Saved elsewhere');
  assert.equal(db.prepare('SELECT count(*) AS n FROM note_presence').get().n, 2);
});

test('collaboration enforces edit rights and rejects invalid or oversized documents', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner, { content: 'Short' });
  await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes: [{ user_id: 2, role: 'viewer' }] });
  assert.equal((await collabClient(host(2), note.id)).status, 403);
  assert.equal((await collabClient(host(3), note.id)).status, 404);
  const a = await collabClient(owner, note.id);
  const garbage = await owner.request('POST', '/collab', { action: 'sync', note_id: note.id, client_id: a.doc.clientID, since: 0,
    updates: ['not-yjs'] });
  assert.equal(garbage.status, 400);
  a.doc.getText('content').insert(0, 'x'.repeat(24001));
  assert.equal((await a.sync()).status, 400);
  // After a rejected update the session has a gap; later updates are refused until it rejoins.
  a.doc.getMap('properties').set('fare', { id: 'fare', name: 'Fare', type: 'number', value: 1, position: 0 });
  assert.equal((await a.sync()).status, 409);
  // A value that is not valid yet (here a non-HTTP URL, as while typing one) keeps the session and the stored properties.
  const fresh = await collabClient(owner, note.id);
  fresh.doc.getMap('properties').set('bad', { id: 'bad', name: 'Bad', type: 'url', value: 'javascript:alert(1)', position: 0 });
  fresh.doc.getMap('meta').set('icon', '<3');
  assert.equal((await fresh.sync()).status, 200);
  const kept = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  assert.deepEqual(kept.properties, []); assert.equal(kept.icon, null);
  fresh.doc.getMap('properties').set('bad', { id: 'bad', name: 'Bad', type: 'url', value: 'https://ok.example', position: 0 });
  fresh.doc.getMap('meta').delete('icon'); fresh.doc.getText('title').delete(0, fresh.doc.getText('title').length);
  assert.equal((await fresh.sync()).status, 200);
  const settled = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  assert.equal(settled.properties[0].value, 'https://ok.example'); assert.equal(settled.title, kept.title);
  fresh.doc.getMap('properties').set('huge', { id: 'huge', name: 'Huge', type: 'text', value: 'x'.repeat(40000), position: 1 });
  assert.equal((await fresh.sync()).status, 400);
  for (const smuggle of [(doc) => doc.getMap('junk').set('x', 'y'), (doc) => doc.getMap('meta').set('junk', 'y')]) {
    const session = await collabClient(owner, note.id); smuggle(session.doc);
    assert.equal((await session.sync()).status, 400);
  }
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).data.content, 'Short');
});

test('collaboration compacts history and catches up clients that fell behind', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner, { content: '' });
  const a = await collabClient(owner, note.id); const late = await collabClient(owner, note.id);
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 40; i += 1) a.doc.getText('content').insert(a.text().length, String(i % 10));
    assert.equal((await a.sync()).status, 200);
  }
  assert.ok(db.prepare('SELECT count(*) AS n FROM note_updates').get().n < 100);
  await late.sync(); assert.equal(late.text(), a.text()); assert.equal(late.text().length, 120);
});

test('note icons accept emoji or small raster images, persist through saves, collab and snapshots', async (t) => {
  const { owner } = await setup(t);
  const png = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;
  const note = await create(owner, { icon: '🚃' });
  assert.equal(note.icon, '🚃');
  const save = (fields) => owner.request('POST', '/save', { title: 'T', content: '', ...fields });
  for (const icon of ['data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(150001)}`, '<img>', 'x'.repeat(17)]) {
    assert.equal((await save({ icon })).status, 400, icon.slice(0, 30));
  }
  const kept = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: 'Kept', content: '' })).data;
  assert.equal(kept.icon, '🚃');
  const image = (await owner.request('POST', '/save', { id: kept.id, version: kept.version, title: 'Kept', content: '', icon: png })).data;
  assert.equal(image.icon, png);
  const client = await collabClient(owner, note.id);
  assert.equal(client.doc.getMap('meta').get('icon'), png);
  client.doc.getMap('meta').set('icon', '🗾'); await client.sync();
  const synced = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  assert.equal(synced.icon, '🗾');
  await link(owner, synced, 10, 'snapshot');
  assert.equal((await readTrip(owner)).data.notes[0].icon, '🗾');
  const cleared = (await owner.request('POST', '/save', { id: synced.id, version: synced.version, title: 'Kept', content: '',
    icon: null })).data;
  assert.equal(cleared.icon, null);
});

test('folder deletion requires ownership and an empty folder', async (t) => {
  const { owner, host } = await setup(t);
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Empty' })).data;
  assert.equal(folder.icon, null);
  const customIcon = (await owner.request('POST', '/folder', { action: 'create', name: 'Custom', icon: '🗺️' })).data;
  assert.equal(customIcon.icon, '🗺️');
  assert.equal((await host(2).request('POST', '/folder', { action: 'archive', folder_id: folder.id })).status, 404);
  const child = (await owner.request('POST', '/folder', { action: 'create', name: 'Child', parent_id: folder.id })).data;
  assert.equal((await owner.request('POST', '/folder', { action: 'archive', folder_id: folder.id })).status, 409);
  assert.equal((await owner.request('POST', '/folder', { action: 'archive', folder_id: child.id })).status, 200);
  const noteFolder = (await owner.request('POST', '/folder', { action: 'create', name: 'With note' })).data;
  await create(owner, { folder_id: noteFolder.id });
  assert.equal((await owner.request('POST', '/folder', { action: 'archive', folder_id: noteFolder.id })).status, 409);
  assert.equal((await owner.request('POST', '/folder', { action: 'archive', folder_id: folder.id })).status, 200);
  assert.equal((await owner.request('GET', '/folders')).data.some((item) => item.id === folder.id), false);
});

test('per-note typed properties validate, persist, survive omitted updates and snapshot', async (t) => {
  const { owner } = await setup(t);
  const status = { id: 'status', name: 'Status', type: 'select', options: [{ id: 'doing', name: 'Doing', color: 2 }], value: 'doing' };
  const properties = [
    { id: 'fare', name: 'Fare', type: 'number', value: 170 }, { id: 'due', name: 'Due', type: 'date', value: '2026-10-01' }, status,
    { id: 'tags', name: 'Kinds', type: 'multi_select', options: [{ id: 'rail', name: 'Rail', color: 0 },
      { id: 'bus', name: 'Bus', color: 5 }], value: ['rail', 'rail'] },
    { id: 'ok', name: 'Booked', type: 'checkbox', value: true },
    { id: 'site', name: 'Site', type: 'url', value: 'https://www.jreast.co.jp' },
    { id: 'todo', name: 'Todo', type: 'checklist', value: [{ text: 'Buy Suica', done: true }, { text: 'Top up', done: false }] },
    { id: 'edited', name: 'Last edited', type: 'last_edited', value: 'ignored' },
  ];
  const note = await create(owner, { properties });
  assert.equal(note.properties.find((item) => item.id === 'tags').value.length, 1);
  assert.equal(note.properties.find((item) => item.id === 'edited').value, null);
  for (const property of [{ id: 'x', name: 'X', type: 'url', value: 'javascript:alert(1)' },
    { id: 'x', name: 'X', type: 'number', value: '12' },
    { ...status, value: 'missing' }, { id: 'x', name: 'X', type: 'formula', value: 1 },
    { id: 'x y', name: 'X', type: 'text', value: '' }]) {
    assert.equal((await owner.request('POST', '/save', { title: 'Bad', content: '', tags: [], properties: [property] })).status, 400,
      JSON.stringify(property));
  }
  const edited = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: 'Renamed', content: note.content,
    tags: [] })).data;
  assert.equal(edited.properties.length, properties.length);
  await link(owner, edited, 10, 'snapshot');
  assert.equal((await readTrip(owner)).data.notes[0].properties.find((item) => item.id === 'fare').value, 170);
});

test('search matches visible property values, never JSON keys, and tags stay optional', async (t) => {
  const { owner } = await setup(t);
  const kinds = { id: 'kinds', name: 'Kinds', type: 'multi_select', options: [{ id: 'rail', name: '铁路', color: 0 },
    { id: 'bus', name: 'Bus', color: 1 }], value: ['rail'] };
  const note = await create(owner, { title: 'Pass', content: 'Body', tags: undefined,
    properties: [kinds, { id: 'todo', name: 'Todo', type: 'checklist', value: [{ text: 'Top up Suica', done: false }] }] });
  const titles = async (q) => (await owner.request('GET', '/notes', {}, { q })).data.notes.map((item) => item.title);
  assert.deepEqual(await titles('铁路'), ['Pass']); assert.deepEqual(await titles('suica'), ['Pass']);
  for (const q of ['multi_select', 'Bus', 'kinds', 'rail']) assert.deepEqual(await titles(q), [], q);
  const legacy = await create(owner, { title: 'Legacy', tags: ['Japan'] });
  const saved = (await owner.request('POST', '/save', { id: legacy.id, version: legacy.version, title: 'Legacy 2',
    content: legacy.content })).data;
  assert.deepEqual(saved.tags, ['Japan']); assert.deepEqual(note.tags, []);
});

test('search treats SQL wildcard characters literally and preserves unicode', async (t) => {
  const { owner } = await setup(t);
  await create(owner, { title: '上海 100%_交通' }); await create(owner);
  assert.equal((await owner.request('GET', '/notes', {}, { q: '%_' })).data.notes.length, 1);
  assert.equal((await owner.request('GET', '/notes', {}, { q: "' OR 1=1 --" })).data.notes.length, 0);
  assert.equal((await owner.request('GET', '/notes', {}, { offset: -1 })).status, 400);
});

test('optimistic revisions prevent lost updates and stale deletion', async (t) => {
  const { owner } = await setup(t); const note = await create(owner);
  assert.equal((await owner.request('POST', '/save', { ...note, title: 'Updated' })).status, 200);
  assert.equal((await owner.request('POST', '/save', note)).status, 409);
  assert.equal((await owner.request('POST', '/archive', note)).status, 409);
});

test('live references follow edits; snapshots survive edit and archive', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner);
  assert.equal((await link(owner, note)).status, 200);
  assert.equal((await link(owner, note, 20, 'snapshot', 201)).status, 200);
  assert.equal((await link(owner, note)).status, 409);
  const changed = await owner.request('POST', '/save', { ...note, content: 'Updated content' });
  assert.equal((await readTrip(host(2))).data.notes[0].content, 'Updated content');
  assert.equal((await readTrip(owner, 20)).data.notes[0].content, note.content);
  await owner.request('POST', '/archive', changed.data);
  assert.equal((await readTrip(host(2))).data.notes[0].unavailable, true);
  assert.equal((await readTrip(owner, 20)).data.notes[0].content, note.content);
});

test('trip access, source ownership, day membership and edit permission are enforced', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner);
  assert.equal((await link(host(2), note)).status, 404);
  assert.equal((await link(owner, note, 10, 'live', 201)).status, 400);
  assert.equal((await readTrip(host(3))).status, 403);
  const viewer = host(1, { trips: { 10: { members: [1], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await link(viewer, note)).status, 403);
  await link(owner, note);
  assert.equal((await viewer.request('POST', '/trip', { action: 'unlink', trip_id: 10, note_id: note.id })).status, 403);

  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Locked' })).data;
  const readOnlyMember = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folders', trip_id: 10 })).status, 200);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'No write' })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_icon', trip_id: 10, folder_id: folder.id,
    icon: '🌐' })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip',
    { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_move', trip_id: 10, note_id: note.id,
    folder_id: folder.id })).status, 403);
});

test('trip-created notes persist their private source, live link and trip folder atomically', async (t) => {
  const { owner, host, db } = await setup(t);
  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Transport' })).data;
  const input = { trip_id: 10, trip_folder_id: folder.id, title: 'Airport transfer', content: 'Take the express train.',
    tags: ['airport'] };
  owner.ctx.db.failTxAt = 3;
  assert.equal((await owner.request('POST', '/trip-note', input)).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_links').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_folders').get().count, 0);
  delete owner.ctx.db.failTxAt;

  const created = await owner.request('POST', '/trip-note', input);
  assert.equal(created.status, 200);
  assert.equal(created.data.owner_id, 1);
  assert.equal(created.data.visibility, 'private');
  const listed = await readTrip(owner);
  assert.equal(listed.data.notes[0].id, created.data.id);
  assert.equal(listed.data.notes[0].mode, 'live');
  assert.equal(listed.data.notes[0].folder_id, folder.id);

  const readOnlyMember = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'can_edit', trip_id: 10 })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip-note', { ...input, title: 'Forbidden' })).status, 403);
});

test('live sharing is revoked when the author leaves, frozen copies remain', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner);
  await link(owner, note);
  const remaining = host(2, { trips: { 10: { members: [2], data: { id: 10, user_id: 2 } } } });
  assert.equal((await readTrip(remaining)).data.notes[0].unavailable, true);
});

test('trip members discuss a note in threads; authors edit, editors moderate, unlinking takes the threads along', async (t) => {
  const { owner, host, db } = await setup(t); const note = await create(owner); await link(owner, note);
  const comment = (h, input) => h.request('POST', '/trip', { trip_id: 10, note_id: note.id, ...input });
  const member = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1, title: 'Japan' }, canEditTrip: false } } });
  const opened = await comment(member, { action: 'comment_add', body: ' Is it still 500 yen? ', quote: 'Keep a spare.',
    prefix: 'IC card\n', suffix: '' });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const [root] = opened.data;
  assert.equal(root.author_id, 2); assert.equal(root.author.username, 'sherwin'); assert.equal(root.author.color, '#10b981');
  assert.equal(root.body, 'Is it still 500 yen?'); assert.equal(root.quote, 'Keep a spare.'); assert.equal(root.prefix, 'IC card\n');
  const replied = await comment(owner, { action: 'comment_add', parent_id: root.id, body: 'Yes.', quote: 'ignored' });
  const reply = replied.data[1];
  assert.equal(reply.parent_id, root.id); assert.equal(reply.quote, null);
  assert.equal((await comment(owner, { action: 'comment_add', parent_id: reply.id, body: 'Nested' })).status, 404);
  assert.equal((await comment(host(3), { action: 'comments' })).status, 403);
  assert.equal((await comment(member, { action: 'comment_add', body: '   ' })).status, 400);
  assert.equal((await comment(member, { action: 'comment_add', body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await comment(owner, { action: 'comment_edit', comment_id: root.id, body: 'Hijacked' })).status, 403);
  const edited = await comment(member, { action: 'comment_edit', comment_id: root.id, body: 'Still 500 yen?' });
  assert.equal(edited.data[0].body, 'Still 500 yen?');
  const resolved = await comment(member, { action: 'comment_resolve', comment_id: root.id, resolved: true });
  assert.ok(resolved.data[0].resolved_at); assert.equal(resolved.data[0].resolved_by, 2);
  assert.equal((await comment(member, { action: 'comment_resolve', comment_id: root.id, resolved: false })).data[0].resolved_at, null);
  assert.equal((await comment(member, { action: 'comment_resolve', comment_id: reply.id, resolved: true })).status, 400);
  // Read-only members remove only their own words; trip editors may remove any thread, replies included.
  assert.equal((await comment(member, { action: 'comment_delete', comment_id: reply.id })).status, 403);
  assert.equal((await comment(owner, { action: 'comment_delete', comment_id: root.id })).data.length, 0);
  await comment(member, { action: 'comment_add', body: 'About the whole note' });
  assert.equal((await owner.request('POST', '/trip', { action: 'unlink', trip_id: 10, note_id: note.id })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_comments').get().count, 0);
  assert.equal((await comment(member, { action: 'comments' })).status, 404);
});

test('the companion stamps the signed-in author, whatever the page sends', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner); await link(owner, note);
  const target = host(2);
  const dependent = createMockHost({ grants: tripManifest.permissions, actingUserId: 2,
    pluginExports: { fieldnotes: { trip: (args) => main.exports.trip(args, target.ctx) } } });
  const response = await dependent.run(companion).route({ method: 'POST', path: '/trip' },
    { body: { action: 'comment_add', trip_id: 10, note_id: note.id, body: 'Hi', actor_id: 1 } });
  assert.equal(JSON.parse(response.body)[0].author_id, 2);
  const outsider = { action: 'comment_add', trip_id: 10, note_id: note.id, body: 'Hi', actor_id: 3 };
  assert.equal(outcome(await main.exports.trip(outsider, target.ctx)).status, 403);
  assert.equal(outcome(await main.exports.trip({ action: 'comments', trip_id: 10, note_id: note.id }, target.ctx)).status, 401);
});

test('trip editors edit a snapshot in place, its images copied in and stale saves refused', async (t) => {
  const { owner, host, db } = await setup(t);
  const note = await create(owner, { content: '![station](fieldnotes://trip-file/10/5)' });
  await link(owner, note, 10, 'snapshot'); await link(owner, note, 20);
  const [snapshot] = (await readTrip(owner)).data.notes;
  const save = (h, fields, trip = 10) => h.request('POST', '/trip', { action: 'snapshot_save', trip_id: trip, note_id: note.id,
    version: snapshot.version, title: snapshot.title, content: snapshot.content, ...fields });
  const readOnly = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await save(readOnly, { content: 'No' })).status, 403);
  assert.equal((await readOnly.request('POST', '/trip', { action: 'upload', trip_id: 10, part: 0, parts: 1, data: png })).status, 403);
  assert.equal((await save(owner, {}, 20)).status, 404);
  const uploaded = await host(2).request('POST', '/trip', { action: 'upload', trip_id: 10, part: 0, parts: 1, data: png });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  const { source } = uploaded.data;
  const saved = await save(host(2), { title: 'Transport for this trip', content: `![photo](${source})`, icon: '🚆' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.title, 'Transport for this trip'); assert.equal(saved.data.icon, '🚆');
  assert.equal(saved.data.mode, 'snapshot'); assert.equal(saved.data.version, snapshot.version + 1);
  assert.deepEqual(db.prepare('SELECT source FROM snapshot_assets').all().map((row) => row.source), [source]);
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).data.content, note.content);
  assert.equal((await save(owner, { content: 'Stale' })).status, 409);
  assert.equal((await readTrip(owner)).data.notes[0].content, `![photo](${source})`);
  // The snapshot keeps its own copy after the upload itself is gone.
  db.prepare('DELETE FROM note_assets').run();
  const image = await host(2).request('POST', '/trip', { action: 'asset', trip_id: 10, note_id: note.id, source });
  assert.equal(image.data.data_url, `data:image/png;base64,${png}`);
});

test('live references turn into snapshots only for people who could import one', async (t) => {
  const { owner, host, db } = await setup(t);
  const note = await create(owner, { content: '![station](fieldnotes://trip-file/10/5)' });
  await link(owner, note);
  assert.equal((await readTrip(owner)).data.notes[0].can_snapshot, true);
  assert.equal((await readTrip(host(2))).data.notes[0].can_snapshot, false);
  const convert = (h) => h.request('POST', '/trip', { action: 'snapshot_convert', trip_id: 10, note_id: note.id });
  assert.equal((await convert(host(2))).status, 403);
  await owner.request('POST', '/trip', { action: 'comment_add', trip_id: 10, note_id: note.id, body: 'Keep this' });
  const converted = await convert(owner);
  assert.equal(converted.status, 200, JSON.stringify(converted));
  assert.equal(converted.data.mode, 'snapshot'); assert.equal(converted.data.content, note.content);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshot_assets').get().count, 1);
  assert.equal((await convert(owner)).status, 409);
  await owner.request('POST', '/save', { ...note, content: 'Changed later' });
  assert.equal((await readTrip(host(2))).data.notes[0].content, note.content);
  assert.equal((await owner.request('POST', '/trip', { action: 'comments', trip_id: 10, note_id: note.id })).data.length, 1);
});

test('user erasure removes authored comments with their threads; export lists them', async (t) => {
  const { owner, host, db } = await setup(t); const note = await create(owner); await link(owner, note);
  const comment = (h, input) => h.request('POST', '/trip', { trip_id: 10, note_id: note.id, ...input });
  const [kept] = (await comment(owner, { action: 'comment_add', body: 'Owner thread' })).data;
  await comment(host(2), { action: 'comment_add', parent_id: kept.id, body: 'Member reply' });
  const opened = (await comment(host(2), { action: 'comment_add', body: 'Member thread' })).data.at(-1);
  await comment(owner, { action: 'comment_add', parent_id: opened.id, body: 'Owner reply' });
  assert.equal((await owner.run(main).exportUserData(2)).tripComments.length, 2);
  await owner.run(main).deleteUserData(2);
  assert.deepEqual(db.prepare('SELECT body FROM trip_note_comments').all().map((row) => row.body), ['Owner thread']);
});

test('trip fieldnote folders scope links without changing the source note folder', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner, { folder_id: null }); await link(owner, note);
  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Transport' })).data;
  assert.equal(folder.icon, null);
  assert.equal((await owner.request('POST', '/trip', { action: 'list', trip_id: 10 })).data.notes.length, 1);
  await owner.request('POST', '/trip', { action: 'folder_move', trip_id: 10, note_id: note.id, folder_id: folder.id });
  assert.equal((await owner.request('POST', '/trip', { action: 'list', trip_id: 10, folder_id: folder.id })).data.notes[0].id, note.id);
  assert.equal((await host(2).request('POST', '/trip', { action: 'folders', trip_id: 10 })).data[0].id, folder.id);
  assert.equal((await owner.request('POST', '/trip', { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 409);
  await owner.request('POST', '/trip', { action: 'folder_move', trip_id: 10, note_id: note.id, folder_id: null });
  const child = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Rail', parent_id: folder.id })).data;
  const reparent = (folder_id, parent_id, h = owner) => h.request('POST', '/trip', { action: 'folder_parent', trip_id: 10, folder_id,
    parent_id });
  assert.equal((await reparent(folder.id, child.id)).status, 409);
  const readOnly = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await reparent(child.id, null, readOnly)).status, 403);
  assert.equal((await reparent(child.id, null)).data.parent_id, null);
  assert.equal((await owner.request('POST', '/trip', { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 200);
});

test('user erasure removes owned and user-created trip snapshots, links and assets', async (t) => {
  const { owner, host, db, metadata } = await setup(t);
  const authored = await create(owner, { content: '![station](fieldnotes://trip-file/10/5)' });
  const publicNote = await create(owner, { title: 'Public copy', visibility: 'public' });
  const otherUser = host(2);
  const otherNote = await create(otherUser, { title: 'Other user note' });
  await link(owner, authored, 10, 'snapshot');
  await link(otherUser, publicNote, 10, 'snapshot');
  await link(otherUser, otherNote, 10, 'snapshot');

  assert.equal(metadata.size, 0);
  const exported = await owner.run(main).exportUserData(1);
  assert.equal(exported.tripLinks.length, 2);
  assert.equal(exported.tripSnapshots.length, 2);
  assert.equal(exported.tripSnapshotAssets.length, 1);
  assert.equal((await owner.request('POST', '/trip', { action: 'links', note_id: publicNote.id })).data.length, 1);

  await owner.run(main).deleteUserData(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_links WHERE source_owner_id = 1 OR linked_by = 1').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_snapshots').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshot_assets').get().count, 0);
  assert.equal((await readTrip(otherUser)).data.notes.length, 1);
  assert.equal((await otherUser.request('GET', '/note', {}, { id: publicNote.id })).status, 404);

  await otherUser.run(main).deleteUserData(2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_links').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM trip_note_snapshots').get().count, 0);
});

test('companion calls declared dependency export, not a private or impersonated route', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner); await link(owner, note);
  const target = host(2);
  const dependent = createMockHost({ grants: tripManifest.permissions, actingUserId: 2,
    pluginExports: { fieldnotes: { trip: (args) => main.exports.trip(args, target.ctx) } } });
  const response = await dependent.run(companion).route({ method: 'POST', path: '/trip' }, { body: { action: 'list', trip_id: 10 } });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).notes[0].id, note.id);
  const begin = await dependent.run(companion).route({ method: 'POST', path: '/trip' }, { body: { action: 'begin_note', trip_id: 10 } });
  assert.equal(outcome(begin).status, 200);
  const intent = await target.request('POST', '/trip-intent', { action: 'take' });
  assert.deepEqual(intent.data, { tripId: 10, tripFolderId: null, title: 'Japan' });
  assert.equal((await target.request('POST', '/trip-intent', { action: 'take' })).data, null);
  assert.equal((await target.request('POST', '/trip', { action: 'begin_note', trip_id: 10, actor_id: 1 })).status, 400);
  const forbidden = await main.exports.trip({ action: 'list', trip_id: 20, user_id: 1 }, target.ctx);
  assert.equal(outcome(forbidden).status, 403);
  const forgedLinks = await main.exports.trip({ action: 'links', note_id: note.id, user_id: 1 }, target.ctx);
  assert.equal(outcome(forgedLinks).status, 401);
  assert.deepEqual(Object.keys(main.exports), manifest.capabilities.provides);
  assert.equal(tripManifest.pluginDependencies[0].id, manifest.id);
});

test('declared MCP tool is wired and fails closed for inaccessible trips', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner); await link(owner, note);
  assert.deepEqual(manifest.capabilities.mcpTools.map((tool) => tool.name), main.hooks.mcpToolProvider.tools);
  const result = await owner.run(main).hook('mcpToolProvider', 'callTool', { name: 'list_trip_notes', args: { trip_id: 10 } });
  assert.equal(result.notes[0].id, note.id);
  await assert.rejects(host(3).run(main).hook('mcpToolProvider', 'callTool', { name: 'list_trip_notes', args: { trip_id: 10 } }),
    /RESOURCE_FORBIDDEN/);
});

test('unlink preserves original; GDPR hook deletes only the specified owner', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner); await create(host(2)); await link(owner, note);
  await owner.request('POST', '/trip', { action: 'unlink', trip_id: 10, note_id: note.id });
  assert.equal((await readTrip(owner)).data.notes.length, 0);
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).status, 200);
  await owner.run(main).deleteUserData(1);
  assert.equal((await owner.request('GET', '/notes')).data.notes.length, 0);
  assert.equal((await host(2).request('GET', '/notes')).data.notes.length, 1);
});

test('validates bounds before persistence and rejects forged metadata', async (t) => {
  const { owner } = await setup(t);
  assert.equal((await owner.request('POST', '/save', { title: '', content: '', tags: [] })).status, 400);
  assert.equal((await owner.request('POST', '/save', { title: 'a', content: '你'.repeat(14000), tags: [] })).status, 400);
  assert.equal((await owner.request('POST', '/save', { title: 'a', content: '', tags: Array(13).fill('a') })).status, 400);
  const note = await create(owner);
  assert.equal((await link(owner, note, 10, 'other')).status, 400);
});
