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
const { bodyPartChars, maxContentBytes, maxContentChars } = require('../shared/limits.json');

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
      files: [{ id: 5, name: 'station.png', mimetype: 'image/png', content_base64: Buffer.from('png').toString('base64') },
        { id: 6, original_name: 'Shinkansen ticket.pdf', mime_type: 'application/pdf', mimetype: 'application/pdf', file_size: 30,
          content_base64: Buffer.from('%PDF-1.4\n% ticket\n%%EOF\n').toString('base64') }] },
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
const DAY_MS = 24 * 3600 * 1000;
// How long Recently deleted keeps a note, in the library and in a trip.
const KEPT_MS = 30 * DAY_MS;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]).toString('base64');
const count = (db, table, where = '', ...args) =>
  db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...args).count;
const create = async (owner, fields = {}) => {
  const res = await owner.request('POST', '/save', { title: 'Japan transport', content: '# IC card\nKeep a spare.', tags: ['Japan'],
    ...fields });
  assert.equal(res.status, 200, JSON.stringify(res)); return res.data;
};
const deleteNote = async (h, noteId) => {
  const current = (await h.request('GET', '/note', {}, { id: noteId })).data;
  assert.equal((await h.request('POST', '/archive', { id: current.id, version: current.version })).status, 200);
};
// Sends `data` in `parts` ordered slices, as the page does, and answers with the last part's response.
async function upload(h, { data = png, parts = 2 } = {}) {
  const size = Math.ceil(data.length / parts / 4) * 4; let result = { data: {} };
  for (let part = 0; part < parts && (part === 0 || result.status === 200); part += 1) {
    const slice = data.slice(part * size, (part + 1) * size);
    result = await h.request('POST', '/upload', { upload_id: result.data.upload_id, part, parts, data: slice });
  }
  return result;
}
const shareNote = (h, noteId, changes) => h.request('POST', '/collaborator', { action: 'bulk_roles', note_id: noteId, changes });
const link = (owner, note, trip = 10, mode = 'live', day = null) => owner.request('POST', '/link',
  { note_id: note.id, trip_id: trip, mode, day_id: day });
const readTrip = async (h, trip = 10) => h.request('POST', '/trip', { action: 'list', trip_id: trip });
const unlink = (h, noteId, trip = 10) => h.request('POST', '/trip', { action: 'unlink', trip_id: trip, note_id: noteId });
// A trip's Recently deleted, through the actions its page sends.
const deleted = (h, trip = 10, extra = {}) => h.request('POST', '/trip', { action: 'deleted', trip_id: trip, ...extra });
const deletedRecover = (h, noteId, trip = 10) => h.request('POST', '/trip', { action: 'deleted_recover', trip_id: trip, note_id: noteId });
const deletedDelete = (h, noteId, trip = 10) => h.request('POST', '/trip', { action: 'deleted_delete', trip_id: trip, note_id: noteId });

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

test('image resources enforce note, trip and snapshot permissions', async (t) => {
  const { owner, host } = await setup(t);
  const { source } = (await upload(owner)).data;
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
  const { source } = (await upload(owner)).data;
  const note = await create(owner, { content: `![station](${source})` });
  owner.ctx.db.failTxAt = 3;
  assert.equal((await link(owner, note, 10, 'snapshot')).status, 500);
  assert.equal(count(db, 'trip_note_links'), 0);
  assert.equal(count(db, 'trip_note_snapshots'), 0);
  assert.equal(count(db, 'snapshot_assets'), 0);
  owner.ctx.db.failTxAt = null;
  assert.equal((await link(owner, note, 10, 'snapshot')).status, 200);
  assert.equal(count(db, 'trip_note_links'), 1);
  assert.equal(count(db, 'trip_note_snapshots'), 1);
  assert.equal(count(db, 'snapshot_assets'), 1);
});

test('external image fetch pins checked DNS addresses through redirects and caps streamed bytes', async (t) => {
  const { owner, db } = await setup(t);
  // Unfetchable images are left out of the snapshot instead of blocking it.
  const snapshotWithout = async (note, trip) => { assert.equal((await link(owner, note, trip, 'snapshot')).status, 200);
    assert.equal(count(db, 'snapshot_assets', 'note_id = ?', note.id), 0); };
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
    assert.equal(count(db, 'snapshot_assets', 'note_id = ?', image.id), 1);
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

const age = (db, column, assetId, ms) =>
  db.prepare(`UPDATE note_assets SET ${column} = ? WHERE id = ?`).run(new Date(Date.now() - ms).toISOString(), assetId);

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
  assert.equal(count(db, 'asset_uploads'), 0);
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

test('a library note never reaches a trip’s files, even ones its author can open', async (t) => {
  const { owner, db } = await setup(t);
  const source = 'fieldnotes://trip-file/10/5';
  const note = await create(owner, { content: `![station](${source})` });
  assert.equal((await owner.request('GET', '/asset', {}, { note_id: note.id, source })).status, 400);
  await link(owner, note);
  assert.equal((await owner.request('POST', '/trip', { action: 'asset', trip_id: 10, note_id: note.id, source })).status, 400);
  assert.equal((await link(owner, note, 10, 'snapshot')).status, 409);
  assert.equal((await owner.request('POST', '/trip', { action: 'snapshot_convert', trip_id: 10, note_id: note.id })).status, 200);
  assert.equal(count(db, 'snapshot_assets'), 0);
});

test('search ranks title hits first, needs every word, ignores link targets and brings a passage', async (t) => {
  const { owner } = await setup(t);
  const body = await create(owner, { title: 'Day trips',
    content: 'From Osaka, **Kyoto** is 15 minutes by train.\n![map](https://x.test/kyoto.png)' });
  const titled = await create(owner, { title: 'Kyoto temples', content: 'Kiyomizu opens at six.' });
  await create(owner, { title: 'Map only', content: '![](https://example.test/kyoto.png) [[11111111-1111-1111-1111-111111111111]]' });
  const search = async (q) => (await owner.request('GET', '/notes', {}, { q })).data.notes;
  const found = await search('kyoto');
  assert.deepEqual(found.map((note) => note.id), [titled.id, body.id]); assert.equal(found[0].snippet, null);
  const hit = found.find((note) => note.id === body.id);
  assert.match(hit.snippet, /Kyoto is 15 minutes/); assert.doesNotMatch(hit.snippet, /\*\*/);
  assert.deepEqual((await search('kyoto osaka')).map((note) => note.id), [body.id]);
  assert.deepEqual(await search('example.test'), []); assert.deepEqual(await search('1111'), []);
});

test('a trip page searches the notes shared with it', async (t) => {
  const { owner } = await setup(t);
  const one = await create(owner, { title: 'Ramen', content: 'Shinjuku has the best.' });
  const two = await create(owner, { title: 'Onsen', content: 'Bring a small towel.' });
  await link(owner, one); await link(owner, two);
  const list = async (q) => (await owner.request('POST', '/trip', { action: 'list', trip_id: 10, q })).data.notes.map((note) => note.title);
  assert.deepEqual(await list('towel'), ['Onsen']);
  assert.equal((await list('')).length, 2);
});

test('PDFs upload like images, read through the notes that hold them and are copied into snapshots', async (t) => {
  const { owner, host, db } = await setup(t);
  const pdf = Buffer.from('%PDF-1.7\n% booking\n%%EOF\n').toString('base64');
  const uploaded = await upload(owner, { data: pdf, parts: 1 });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded)); assert.equal(uploaded.data.mimetype, 'application/pdf');
  const { source } = uploaded.data;
  const note = await create(owner, { content: `![Hotel booking.pdf](${source})` });
  const own = await owner.request('GET', '/asset', {}, { note_id: note.id, source });
  assert.equal(own.data.data_url, `data:application/pdf;base64,${pdf}`);
  assert.equal((await host(2).request('GET', '/asset', {}, { note_id: note.id, source })).status, 404);
  assert.equal((await link(owner, note, 20, 'snapshot')).status, 200);
  assert.equal(db.prepare('SELECT mimetype FROM snapshot_assets WHERE source = ?').get(source).mimetype, 'application/pdf');
});

test('a trip reads its own places, bookings, days and stays as cards, never another trip’s or a confirmation number', async (t) => {
  const { host } = await setup(t);
  const japan = { members: [1, 2], data: { id: 10, user_id: 1, title: 'Japan' },
    days: [{ id: 101, trip_id: 10, day_number: 1, date: '2026-11-24', title: 'Arrival', assignments: [
      { place_id: 502, order_index: 1, place: { id: 502, name: 'Nishiki Market' } },
      { place_id: 501, order_index: 0, assignment_time: '09:30',
        place: { id: 501, name: 'Fushimi Inari', category: { name: 'Shrine', icon: '⛩️' } } }] },
      { id: 102, trip_id: 10, day_number: 2, date: '2026-11-25', title: 'Kyoto', assignments: [] }],
    places: [{ id: 501, trip_id: 10, name: 'Fushimi Inari', category: { id: 3, name: 'Shrine', icon: '⛩️' }, lat: 34.9671, lng: 135.7727 },
      { id: 502, trip_id: 10, name: 'Nishiki Market' }],
    reservations: [{ id: 39, trip_id: 10, type: 'flight', title: 'PVG → KIX', status: 'confirmed', confirmation_number: 'DQYZ8T',
      reservation_time: '2026-11-24T06:05', reservation_end_time: '2026-11-24T09:10', day_id: 101, day_positions: { 101: -0.5 },
      metadata: JSON.stringify({ airline: 'Peach', flight_number: 'MM080', seat: '22E', price: '9000' }), endpoints: [
        { role: 'from', name: 'Shanghai Pudong', code: 'PVG', local_time: '06:05', local_date: '2026-11-24', timezone: 'Asia/Shanghai' },
        { role: 'to', name: 'Osaka Kansai', code: 'KIX', local_time: '09:10', local_date: '2026-11-24', timezone: 'Asia/Tokyo' }],
      travelers: [{ user_id: 1, username: 'Tangerine' }] },
      { id: 44, trip_id: 10, type: 'hotel', title: 'soco rooms', accommodation_id: 23, confirmation_number: '5228927938' }],
    accommodations: [{ id: 23, trip_id: 10, place_id: 331, start_day_id: 101, end_day_id: 102, check_in: '15:00', check_out: '11:00',
      confirmation: '5228927938', place_name: 'soco rooms' }] };
  const korea = { members: [1, 2], data: { id: 20, user_id: 1, title: 'Korea' },
    places: [{ id: 900, trip_id: 20, name: 'Gyeongbokgung' }] };
  const owner = host(1, { trips: { 10: japan, 20: korea } });
  const objects = (h, body = {}) => h.request('POST', '/trip', { action: 'objects', trip_id: 10, ...body });

  // An editor lists everything; a hotel booking appears once, as its stay.
  const listed = (await objects(owner)).data.objects;
  assert.deepEqual(listed.map((card) => card.ref), ['day/101', 'day/102', 'stay/23', 'booking/39', 'place/501', 'place/502']);
  assert.doesNotMatch(JSON.stringify(listed), /DQYZ8T|5228927938|9000|Tangerine/);
  const card = (ref) => listed.find((item) => item.ref === ref);
  // A day runs in the plan's order: its places, and the flight set before them; then where the night is spent.
  assert.deepEqual(card('day/101').stops.map((stop) => [stop.time, stop.icon, stop.name]),
    [['06:05', null, 'PVG → KIX'], ['09:30', '⛩️', 'Fushimi Inari'], [null, null, 'Nishiki Market']]);
  assert.equal(card('day/101').stay, 'soco rooms');
  assert.deepEqual([card('place/501').day, card('place/501').time], [{ number: 1, date: '2026-11-24' }, '09:30']);
  assert.equal(card('place/501').link, '/trips/10?tab=plan&place=501');
  assert.equal(card('place/501').map, 'https://www.google.com/maps/search/?api=1&query=34.9671%2C135.7727');
  const flight = card('booking/39');
  assert.deepEqual([flight.number, flight.carrier, flight.seat, flight.from.code, flight.to.zone],
    ['MM080', 'Peach', '22E', 'PVG', 'Asia/Tokyo']);
  assert.deepEqual([card('stay/23').check_in, card('stay/23').from.date], ['15:00', '2026-11-24']);

  // A note's references resolve within this trip only; another trip's place is simply not there.
  const resolved = (await objects(owner, { refs: ['place/501', 'booking/44', 'place/900', 'day/999'] })).data.objects;
  assert.deepEqual(resolved.map((item) => item.ref), ['booking/44', 'place/501']);
  assert.equal((await objects(owner, { refs: ['note/1'] })).status, 400);
  // Any member reads the cards a snapshot shows; only editors list what there is to insert.
  const reader = host(2, { trips: { 10: { ...japan, canEditTrip: false } } });
  assert.equal((await objects(reader, { refs: ['place/501'] })).data.objects.length, 1);
  assert.equal((await objects(reader)).status, 403);
  assert.notEqual((await objects(host(3, { trips: { 10: japan } }), { refs: ['place/501'] })).status, 200);
});

test('snapshot editors list and show the trip’s own PDFs, which a saved snapshot keeps a copy of', async (t) => {
  const { owner, host, db } = await setup(t);
  const files = await owner.request('POST', '/trip', { action: 'files', trip_id: 10 });
  assert.deepEqual(files.data, [{ source: 'fieldnotes://trip-file/10/6', name: 'Shinkansen ticket.pdf', size: 30, created_at: null }]);
  const readOnly = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await readOnly.request('POST', '/trip', { action: 'files', trip_id: 10 })).status, 403);
  const file = (source, trip = 10) => owner.request('POST', '/trip', { action: 'file', trip_id: trip, source });
  assert.match((await file('fieldnotes://trip-file/10/6')).data.data_url, /^data:application\/pdf;base64,/);
  // Another trip's file, even one the editor can open, is not this trip's to show.
  assert.equal((await file('fieldnotes://trip-file/10/6', 20)).status, 404);
  const note = await create(owner); await link(owner, note, 10, 'snapshot');
  const [snapshot] = (await readTrip(owner)).data.notes;
  const saved = await owner.request('POST', '/trip', { action: 'snapshot_save', trip_id: 10, note_id: note.id, version: snapshot.version,
    title: snapshot.title, content: '![Shinkansen ticket.pdf](fieldnotes://trip-file/10/6)' });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(db.prepare('SELECT mimetype FROM snapshot_assets WHERE source = ?').get('fieldnotes://trip-file/10/6').mimetype,
    'application/pdf');
  // A source naming no real trip file, or an id too long to be one, copies nothing and never blocks the save.
  const odd = await owner.request('POST', '/trip', { action: 'snapshot_save', trip_id: 10, note_id: note.id, version: saved.data.version,
    title: snapshot.title, content: '![a](fieldnotes://trip-file/0/1) ![b](fieldnotes://trip-file/10/12345678901234567)' });
  assert.equal(odd.status, 200, JSON.stringify(odd));
});

test('images removed from a note are deleted after a grace window, unless used again, recoverable or kept by a snapshot', async (t) => {
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
  assert.equal(count(db, 'note_assets'), 2);
  age(db, 'released_at', droppedId, 11 * 60 * 1000);
  note = (await owner.request('POST', '/save', { id: note.id, version: note.version, title: note.title,
    content: `![a](${kept}) again` })).data;
  assert.deepEqual(db.prepare('SELECT id FROM note_assets').all().map((row) => row.id), [keptId]);
  assert.equal((await owner.request('GET', '/asset', {}, { note_id: note.id, trip_id: 20, source: dropped })).status, 200);
  // A deleted note keeps its images while it can be recovered; deleting it permanently releases them.
  assert.equal((await owner.request('POST', '/archive', { id: note.id, version: note.version })).status, 200);
  age(db, 'released_at', keptId, 11 * 60 * 1000);
  await upload(owner);
  assert.equal(count(db, 'note_assets', 'id = ?', keptId), 1);
  assert.equal((await owner.request('POST', '/deleted', { action: 'delete', id: note.id })).status, 200);
  assert.equal(count(db, 'note_assets', 'id = ?', keptId), 0);
});

test('uploads never saved into a note survive a day of drafting, then are deleted', async (t) => {
  const { owner, db } = await setup(t);
  const draft = (await upload(owner)).data.source.split('/').pop();
  const stale = (await upload(owner)).data.source.split('/').pop();
  age(db, 'created_at', stale, 25 * 60 * 60 * 1000); age(db, 'created_at', draft, 23 * 60 * 60 * 1000);
  await upload(owner);
  assert.equal(count(db, 'note_assets', 'id = ?', stale), 0);
  assert.equal(count(db, 'note_assets', 'id = ?', draft), 1);
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
  assert.deepEqual(JSON.parse(invalid.body),
    { error: 'Invalid value: title.', status: 400, template: 'Invalid value: {field}.', params: { field: 'title' } });
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
  assert.equal((await shareNote(owner, note.id, [{ user_id: 2, role: 'editor' }])).status, 200);
  const editor = host(2);
  const readableNote = await editor.request('GET', '/note', {}, { id: note.id });
  assert.equal(readableNote.status, 200); assert.equal(readableNote.data.can_edit, true);
  const changed = await editor.request('POST', '/save', { ...note, title: 'Edited together' });
  assert.equal(changed.status, 200); assert.equal(changed.data.title, 'Edited together');
  assert.equal((await shareNote(owner, note.id, [{ user_id: 2, role: 'viewer' }])).status, 200);
  assert.equal((await editor.request('POST', '/save', { ...changed.data, title: 'Should fail' })).status, 403);
  assert.equal((await shareNote(editor, note.id, [{ user_id: 1, role: 'viewer' }])).status, 404);
  assert.equal((await shareNote(owner, note.id, [{ user_id: 2, role: 'none' }])).status, 200);
  assert.equal((await editor.request('GET', '/note', {}, { id: note.id })).status, 404);
});

test('bulk collaborator role updates commit atomically for notes and folders', async (t) => {
  const { owner, db } = await setup(t);
  const note = await create(owner);
  const changes = [{ user_id: 2, role: 'editor' }, { user_id: 3, role: 'viewer' }];
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Shared' })).data;

  owner.ctx.db.failTxAt = 2;
  assert.equal((await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes })).status, 500);
  assert.equal(count(db, 'note_collaborators', 'note_id = ?', note.id), 0);

  assert.equal((await owner.request('POST', '/folder', { action: 'bulk_roles', folder_id: folder.id, changes })).status, 500);
  assert.equal(count(db, 'folder_collaborators', 'folder_id = ?', folder.id), 0);

  delete owner.ctx.db.failTxAt;
  assert.equal((await owner.request('POST', '/collaborator', { action: 'bulk_roles', note_id: note.id, changes })).status, 200);
  assert.equal(count(db, 'note_collaborators', 'note_id = ?', note.id), 2);
});

test('folder permissions inherit without allowing public visibility to bypass private ancestors', async (t) => {
  const { owner, host } = await setup(t);
  const root = (await owner.request('POST', '/folder', { action: 'create', name: 'Japan', visibility: 'private' })).data;
  const child = (await owner.request('POST', '/folder', { action: 'create', name: 'Transport', parent_id: root.id,
    visibility: 'public' })).data;
  const note = await create(owner, { folder_id: child.id });
  const shareFolder = (role) => owner.request('POST', '/folder',
    { action: 'bulk_roles', folder_id: root.id, changes: [{ user_id: 2, role }] });
  assert.equal((await shareFolder('viewer')).status, 200);
  const viewer = host(2);
  assert.equal((await viewer.request('GET', '/folders')).data.find((folder) => folder.id === child.id).role, 'viewer');
  assert.equal((await viewer.request('GET', '/note', {}, { id: note.id })).data.can_edit, false);
  assert.equal((await viewer.request('POST', '/save', { ...note, title: 'No edit yet' })).status, 403);
  assert.equal((await shareFolder('editor')).status, 200);
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
  await shareNote(owner, note.id, [{ user_id: 2, role: 'editor' }]);
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
// With `trip`, the client edits that trip's snapshot of the note through the trip route, as a trip page does.
async function collabClient(h, noteId, trip = null) {
  const call = (body) => (trip ? h.request('POST', '/trip', { ...body, action: 'collab', op: body.action, trip_id: trip })
    : h.request('POST', '/collab', body));
  const doc = new Y.Doc(); const pending = []; let seq = -1;
  doc.on('update', (update, origin) => { if (origin !== 'remote') pending.push(update); });
  const apply = (data) => {
    if (data.state) Y.applyUpdate(doc, Buffer.from(data.state, 'base64'), 'remote');
    for (const update of data.updates) Y.applyUpdate(doc, Buffer.from(update, 'base64'), 'remote');
    seq = data.seq; return data;
  };
  const joined = await call({ action: 'join', note_id: noteId, client_id: doc.clientID });
  if (joined.status !== 200) return { status: joined.status };
  apply(joined.data);
  return {
    doc, joined: joined.data, text: () => doc.getText('content').toString(),
    async sync(cursor = null) {
      const updates = pending.splice(0).map((update) => Buffer.from(update).toString('base64'));
      const result = await call({ action: 'sync', note_id: noteId, client_id: doc.clientID, since: seq, updates, cursor });
      return result.status === 200 ? { status: 200, ...apply(result.data) } : result;
    },
  };
}

test('collaborators co-edit one Yjs document that materializes into the note', async (t) => {
  const { owner, host, db } = await setup(t); const note = await create(owner, { content: 'Suica' });
  await shareNote(owner, note.id, [{ user_id: 2, role: 'editor' }]);
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
  assert.equal(count(db, 'note_presence'), 2);
});

test('collaboration enforces edit rights and rejects invalid or oversized documents', async (t) => {
  const { owner, host } = await setup(t); const note = await create(owner, { content: 'Short' });
  await shareNote(owner, note.id, [{ user_id: 2, role: 'viewer' }]);
  assert.equal((await collabClient(host(2), note.id)).status, 403);
  assert.equal((await collabClient(host(3), note.id)).status, 404);
  const a = await collabClient(owner, note.id);
  const garbage = await owner.request('POST', '/collab', { action: 'sync', note_id: note.id, client_id: a.doc.clientID, since: 0,
    updates: ['not-yjs'] });
  assert.equal(garbage.status, 400);
  a.doc.getText('content').insert(0, 'x'.repeat(maxContentChars + 1));
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
  assert.ok(count(db, 'note_updates') < 100);
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
  assert.equal((await unlink(viewer, note.id)).status, 403);

  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Locked' })).data;
  const readOnlyMember = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folders', trip_id: 10 })).status, 200);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'No write' })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_icon', trip_id: 10, folder_id: folder.id,
    icon: '🌐' })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip',
    { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 403);
  assert.equal((await readOnlyMember.request('POST', '/trip', { action: 'folder_move_note', trip_id: 10, note_id: note.id,
    folder_id: folder.id })).status, 403);
});

test('trip-created notes persist their private source, live link and trip folder atomically', async (t) => {
  const { owner, host, db } = await setup(t);
  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Transport' })).data;
  const input = { trip_id: 10, trip_folder_id: folder.id, title: 'Airport transfer', content: 'Take the express train.',
    tags: ['airport'] };
  owner.ctx.db.failTxAt = 3;
  assert.equal((await owner.request('POST', '/trip-note', input)).status, 500);
  assert.equal(count(db, 'notes'), 0);
  assert.equal(count(db, 'trip_note_links'), 0);
  assert.equal(count(db, 'trip_note_folders'), 0);
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
  assert.equal((await unlink(owner, note.id)).status, 200);
  assert.equal((await comment(member, { action: 'comments' })).status, 404);
  // The thread waits with the note in the trip's Recently deleted, and goes when the note is deleted permanently.
  assert.equal(count(db, 'trip_note_comments'), 1);
  assert.equal((await deletedDelete(owner, note.id)).status, 200);
  assert.equal(count(db, 'trip_note_comments'), 0);
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
  // Only a trip member is recorded as having removed a note; anyone else is refused.
  assert.equal(outcome(await main.exports.trip({ action: 'unlink', trip_id: 10, note_id: note.id, actor_id: 3 }, target.ctx)).status, 403);
  // A refusal reaches the page as the same translatable envelope Fieldnotes sends.
  const signedOut = createMockHost({ grants: tripManifest.permissions });
  const refused = await signedOut.run(companion).route({ method: 'POST', path: '/trip' }, { body: { action: 'list', trip_id: 10 } });
  assert.equal(refused.status, 200); assert.equal(outcome(refused).status, 401);
});

test('trip editors edit a snapshot in place, its images copied in and stale saves refused', async (t) => {
  const { owner, host, db } = await setup(t);
  const station = (await upload(owner)).data.source;
  const note = await create(owner, { content: `![station](${station})` });
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
  // The copy it stopped showing stays for the version that still shows it.
  assert.deepEqual(db.prepare('SELECT source FROM snapshot_assets').all().map((row) => row.source).sort(),
    [station, source].sort());
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).data.content, note.content);
  assert.equal((await save(owner, { content: 'Stale' })).status, 409);
  assert.equal((await readTrip(owner)).data.notes[0].content, `![photo](${source})`);
  // The snapshot keeps its own copy after the upload itself is gone.
  db.prepare('DELETE FROM note_assets').run();
  const image = await host(2).request('POST', '/trip', { action: 'asset', trip_id: 10, note_id: note.id, source });
  assert.equal(image.data.data_url, `data:image/png;base64,${png}`);
});

test('a snapshot is co-edited and versioned on its own, apart from its original and from other trips', async (t) => {
  const { owner, host, db } = await setup(t);
  const note = await create(owner, { content: 'Buy an IC card.' });
  await link(owner, note, 10, 'snapshot'); await link(owner, note, 20, 'snapshot');
  const readOnly = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await collabClient(readOnly, note.id, 10)).status, 403);
  assert.equal((await collabClient(host(9), note.id, 10)).status, 403);
  const a = await collabClient(owner, note.id, 10); const b = await collabClient(host(2), note.id, 10);
  assert.equal(a.text(), 'Buy an IC card.');
  a.doc.getText('content').insert(15, ' Suica works.'); assert.equal((await a.sync()).status, 200);
  await b.sync(); assert.equal(b.text(), 'Buy an IC card. Suica works.');
  const snapshotOf = async (trip) => (await readTrip(owner, trip)).data.notes[0];
  assert.equal((await snapshotOf(10)).content, 'Buy an IC card. Suica works.');
  assert.equal((await snapshotOf(20)).content, 'Buy an IC card.');
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).data.content, 'Buy an IC card.');
  // The first change after the snapshot was taken keeps it as a version; the library note has none of its own.
  const versions = async (h = owner) => (await h.request('POST', '/trip', { action: 'snapshot_history', trip_id: 10,
    note_id: note.id })).data;
  const history = await versions();
  assert.deepEqual(history.versions.map((item) => item.length), [15]);
  assert.deepEqual(history.current.editors, [{ id: 1, name: 'Tangerine' }]);
  assert.deepEqual((await owner.request('GET', '/history', {}, { note_id: note.id })).data.versions, []);
  assert.equal((await readOnly.request('POST', '/trip', { action: 'snapshot_history', trip_id: 10, note_id: note.id })).status, 403);
  const kept = await owner.request('POST', '/trip', { action: 'snapshot_version', trip_id: 10, note_id: note.id,
    version_id: history.versions[0].id });
  assert.equal(kept.data.content, 'Buy an IC card.');
  // A restore reaches open sessions and keeps the text it replaces, so it can be undone.
  const current = await snapshotOf(10);
  const restored = await owner.request('POST', '/trip', { action: 'snapshot_restore', trip_id: 10, note_id: note.id,
    version_id: kept.data.id, version: current.version });
  assert.equal(restored.status, 200, JSON.stringify(restored)); assert.equal(restored.data.content, 'Buy an IC card.');
  await b.sync(); assert.equal(b.text(), 'Buy an IC card.');
  assert.deepEqual((await versions()).versions.map((item) => item.length), [28, 15]);
  // Deleting the removed snapshot permanently takes its document, updates and versions along; the other trip's stay.
  assert.equal((await unlink(owner, note.id)).status, 200);
  assert.equal((await deletedDelete(owner, note.id)).status, 200);
  assert.deepEqual(['note_crdt', 'note_updates', 'note_presence', 'note_versions']
    .map((table) => count(db, table, "note_id LIKE 'trip:10:%'")), [0, 0, 0, 0]);
  const other = await collabClient(owner, note.id, 20); assert.equal(other.text(), 'Buy an IC card.');
});

test('a snapshot copies an image in as it is typed, and an earlier version still shows the one it dropped', async (t) => {
  const { owner, db } = await setup(t);
  const first = (await upload(owner)).data.source; const second = (await upload(owner)).data.source;
  const note = await create(owner, { content: `![one](${first})` });
  await link(owner, note, 10, 'snapshot');
  const a = await collabClient(owner, note.id, 10);
  const content = a.doc.getText('content');
  a.doc.transact(() => { content.delete(0, content.length); content.insert(0, `![two](${second})`); });
  assert.equal((await a.sync()).status, 200);
  const copies = () => db.prepare('SELECT source FROM snapshot_assets ORDER BY source').all().map((row) => row.source);
  assert.deepEqual(copies(), [first, second].sort());
  db.prepare('DELETE FROM note_assets').run();
  const [version] = (await owner.request('POST', '/trip', { action: 'snapshot_history', trip_id: 10, note_id: note.id })).data.versions;
  const image = await owner.request('POST', '/trip', { action: 'asset', trip_id: 10, note_id: note.id, source: first,
    version_id: version.id });
  assert.equal(image.data.data_url, `data:image/png;base64,${png}`);
  // Once no version shows it either, the next editor to join drops the copy.
  db.prepare("DELETE FROM note_versions WHERE note_id LIKE 'trip:%'").run();
  await collabClient(owner, note.id, 10);
  assert.deepEqual(copies(), [second]);
});

test('live references turn into snapshots only for people who could import one', async (t) => {
  const { owner, host, db } = await setup(t);
  const note = await create(owner, { content: `![station](${(await upload(owner)).data.source})` });
  await link(owner, note);
  assert.equal((await readTrip(owner)).data.notes[0].can_snapshot, true);
  assert.equal((await readTrip(host(2))).data.notes[0].can_snapshot, false);
  const convert = (h) => h.request('POST', '/trip', { action: 'snapshot_convert', trip_id: 10, note_id: note.id });
  assert.equal((await convert(host(2))).status, 403);
  await owner.request('POST', '/trip', { action: 'comment_add', trip_id: 10, note_id: note.id, body: 'Keep this' });
  const converted = await convert(owner);
  assert.equal(converted.status, 200, JSON.stringify(converted));
  assert.equal(converted.data.mode, 'snapshot'); assert.equal(converted.data.content, note.content);
  assert.equal(count(db, 'snapshot_assets'), 1);
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
  await owner.request('POST', '/trip', { action: 'folder_move_note', trip_id: 10, note_id: note.id, folder_id: folder.id });
  assert.equal((await readTrip(owner)).data.notes[0].folder_id, folder.id);
  assert.equal((await host(2).request('POST', '/trip', { action: 'folders', trip_id: 10 })).data[0].id, folder.id);
  assert.equal((await owner.request('POST', '/trip', { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 409);
  await owner.request('POST', '/trip', { action: 'folder_move_note', trip_id: 10, note_id: note.id, folder_id: null });
  const child = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Rail', parent_id: folder.id })).data;
  const reparent = (folder_id, parent_id, h = owner) => h.request('POST', '/trip', { action: 'folder_move', trip_id: 10, folder_id,
    parent_id });
  assert.equal((await reparent(folder.id, child.id)).status, 409);
  const readOnly = host(2, { trips: { 10: { members: [1, 2], data: { id: 10, user_id: 1 }, canEditTrip: false } } });
  assert.equal((await reparent(child.id, null, readOnly)).status, 403);
  assert.equal((await reparent(child.id, null)).data.parent_id, null);
  assert.equal((await owner.request('POST', '/trip', { action: 'folder_archive', trip_id: 10, folder_id: folder.id })).status, 200);
});

test('user erasure removes owned and user-created trip snapshots, links and assets', async (t) => {
  const { owner, host, db, metadata } = await setup(t);
  const authored = await create(owner, { content: `![station](${(await upload(owner)).data.source})` });
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
  assert.equal(count(db, 'trip_note_links', 'source_owner_id = 1 OR linked_by = 1'), 0);
  assert.equal(count(db, 'trip_note_snapshots'), 1);
  assert.equal(count(db, 'snapshot_assets'), 0);
  assert.equal((await readTrip(otherUser)).data.notes.length, 1);
  assert.equal((await otherUser.request('GET', '/note', {}, { id: publicNote.id })).status, 404);

  await otherUser.run(main).deleteUserData(2);
  assert.equal(count(db, 'trip_note_links'), 0);
  assert.equal(count(db, 'trip_note_snapshots'), 0);
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
  await unlink(owner, note.id);
  assert.equal((await readTrip(owner)).data.notes.length, 0);
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).status, 200);
  await owner.run(main).deleteUserData(1);
  assert.equal((await owner.request('GET', '/notes')).data.notes.length, 0);
  assert.equal((await host(2).request('GET', '/notes')).data.notes.length, 1);
});

test('validates bounds before persistence and rejects forged metadata', async (t) => {
  const { owner } = await setup(t);
  assert.equal((await owner.request('POST', '/save', { title: '', content: '', tags: [] })).status, 400);
  const heavy = '你'.repeat(Math.floor(maxContentBytes / 3) + 1);
  assert.equal((await owner.request('POST', '/save', { title: 'a', content: heavy, tags: [] })).status, 400);
  assert.equal((await owner.request('POST', '/save', { title: 'a', content: '', tags: Array(13).fill('a') })).status, 400);
  const note = await create(owner);
  assert.equal((await link(owner, note, 10, 'other')).status, 400);
});

test('id links survive a rename, while a hand-typed title link follows the title', async (t) => {
  const { owner } = await setup(t);
  const kyoto = await create(owner, { title: 'Kyoto', content: 'Maples.' });
  const byId = await create(owner, { title: 'Autumn plan', content: `Day 3:\n- Walk to [[${kyoto.id}|Kyoto]] early` });
  const byTitle = await create(owner, { title: 'Packing', content: 'See [[Kyoto]] for shoes.' });
  const mentions = async () => (await owner.request('GET', '/backlinks', {}, { note_id: kyoto.id })).data.notes;
  assert.deepEqual((await mentions()).map((item) => [item.id, item.snippet]).sort(),
    [[byId.id, 'Walk to Kyoto early'], [byTitle.id, 'See Kyoto for shoes.']].sort());
  assert.equal((await owner.request('POST', '/save', { ...kyoto, title: 'Kyoto in autumn' })).status, 200);
  assert.deepEqual((await owner.request('GET', '/reference', {}, { ref: kyoto.id })).data,
    { reference: kyoto.id, id: kyoto.id, title: 'Kyoto in autumn' });
  assert.equal((await owner.request('GET', '/reference', {}, { ref: 'Kyoto' })).data.unavailable, true);
  assert.deepEqual((await mentions()).map((item) => [item.id, item.snippet]), [[byId.id, 'Walk to Kyoto in autumn early']]);
});

test('link suggestions and backlinks only reach notes the reader may open', async (t) => {
  const { owner, host } = await setup(t);
  const kyoto = await create(owner, { title: 'Kyoto in autumn' });
  const tokyo = await create(owner, { title: 'Tokyo transit', content: `Then [[${kyoto.id}|Kyoto]].` });
  await create(owner, { title: 'Osaka food', content: 'Kyoto is near.' });
  const stranger = host(2);
  const theirs = await create(stranger, { title: 'Kyoto shrines', content: `Like [[${kyoto.id}]].` });
  const titles = async (h, q, exclude) => (await h.request('GET', '/link-targets', {}, { q, ...(exclude ? { exclude } : {}) }))
    .data.notes.map((item) => item.title);
  // A title prefix ranks above a match inside a word.
  assert.deepEqual(await titles(owner, 'kyo'), ['Kyoto in autumn', 'Tokyo transit']);
  assert.deepEqual(await titles(owner, 'tr'), ['Tokyo transit']);
  assert.deepEqual((await titles(owner, '', kyoto.id)).sort(), ['Osaka food', 'Tokyo transit']);
  assert.deepEqual(await titles(stranger, 'kyo'), ['Kyoto shrines']);
  assert.deepEqual(await titles(stranger, 'tokyo'), []);
  assert.deepEqual((await owner.request('GET', '/backlinks', {}, { note_id: kyoto.id })).data.notes.map((item) => item.id), [tokyo.id]);
  assert.equal((await stranger.request('GET', '/backlinks', {}, { note_id: kyoto.id })).status, 404);
  assert.equal(theirs.owner_id, 2);
});

test('on a trip, links resolve, suggest and point back only among the trip’s notes', async (t) => {
  const { owner, host } = await setup(t);
  const kyoto = await create(owner, { title: 'Kyoto in autumn' });
  const tokyo = await create(owner, { title: 'Tokyo transit', content: `Then [[${kyoto.id}|Kyoto]] and [[Osaka food]].` });
  await create(owner, { title: 'Osaka food' });
  await link(owner, kyoto); await link(owner, tokyo, 10, 'snapshot');
  const member = host(2);
  const trip = (action, fields) => member.request('POST', '/trip', { action, trip_id: 10, ...fields });
  assert.equal((await trip('reference', { ref: kyoto.id })).data.title, 'Kyoto in autumn');
  assert.equal((await trip('reference', { ref: 'Osaka food' })).data.unavailable, true);
  assert.deepEqual((await trip('link_targets', { q: '', exclude: tokyo.id })).data.notes.map((item) => item.title), ['Kyoto in autumn']);
  assert.deepEqual((await trip('backlinks', { note_id: kyoto.id })).data.notes.map((item) => item.id), [tokyo.id]);
  assert.equal((await host(3).request('POST', '/trip', { action: 'backlinks', trip_id: 10, note_id: kyoto.id })).status, 403);
});

test('a link reports who cannot open its note, and only that note’s owner can let them, through the usual sharing', async (t) => {
  const { owner, host } = await setup(t);
  const target = await create(owner, { title: 'Entry checklist' });
  const source = await create(owner, { title: 'Kyoto plan', content: `See [[${target.id}|Entry checklist]].` });
  assert.equal((await shareNote(owner, source.id, [{ user_id: 2, role: 'viewer' }])).status, 200);
  await link(owner, source, 30);
  const access = async () => (await owner.request('GET', '/link-access', {}, { note_id: source.id, targets: target.id })).data.links;
  const [gap] = await access();
  assert.deepEqual({ target: gap.target.title, people: gap.people.map((person) => [person.user.id, person.grantable]),
    trips: gap.trips, hidden: gap.hidden_trips, public: gap.public, share: gap.can_share },
  { target: 'Entry checklist', people: [[2, true]], trips: [{ id: 30, title: 'Taiwan' }], hidden: 0, public: false, share: true });
  const restricted = async () => (await owner.request('GET', '/link-targets', {}, { q: 'entry', exclude: source.id }))
    .data.notes[0].restricted;
  assert.equal(await restricted(), true);

  const grant = (h, fields) => h.request('POST', '/link-grant', { note_id: source.id, target_id: target.id, ...fields });
  assert.equal((await grant(owner, { user_ids: [3] })).status, 400);
  assert.equal((await grant(host(2), { user_ids: [2] })).status, 404);
  assert.equal((await host(2).request('GET', '/note', {}, { id: target.id })).status, 404);
  const granted = await grant(owner, { user_ids: [2], trip_ids: [30] });
  assert.deepEqual(granted.data, { links: [] });
  assert.equal((await host(2).request('GET', '/note', {}, { id: target.id })).status, 200);
  assert.equal((await owner.request('GET', '/collaborators', {}, { note_id: target.id })).data.collaborators[0].role, 'viewer');
  assert.ok((await readTrip(host(3), 30)).data.notes.some((item) => item.id === target.id && item.mode === 'live'));
  assert.equal(await restricted(), false);
});

test('a public note linking a private one says so, and needs no names to say it', async (t) => {
  const { owner } = await setup(t);
  const target = await create(owner, { title: 'Hotel bookings' });
  const source = await create(owner, { title: 'Public guide', visibility: 'public', content: `[[${target.id}|Hotel bookings]]` });
  const [gap] = (await owner.request('GET', '/link-access', {}, { note_id: source.id, targets: target.id })).data.links;
  assert.deepEqual([gap.public, gap.people, gap.trips], [true, [], []]);
  assert.deepEqual((await owner.request('GET', '/link-access', {}, { note_id: target.id, targets: source.id })).data.links, []);
});

test('a backlink snippet names only the notes its reader may open', async (t) => {
  const { owner, host } = await setup(t);
  const target = await create(owner, { title: 'Entry checklist' });
  const secret = await create(owner, { title: 'Secret plan' });
  const open = await create(owner, { title: 'Ramen map' });
  const source = await create(owner, { title: 'Kyoto plan',
    content: `Read [[${target.id}|Entry checklist]], [[${secret.id}|Secret plan]] and [[${open.id}|Ramen map]].` });
  for (const note of [target, source, open]) await shareNote(owner, note.id, [{ user_id: 2, role: 'viewer' }]);
  const snippet = async (h) => (await h.request('GET', '/backlinks', {}, { note_id: target.id })).data.notes[0].snippet;
  assert.equal(await snippet(owner), 'Read Entry checklist, Secret plan and Ramen map.');
  assert.equal(await snippet(host(2)), 'Read Entry checklist,  and Ramen map.');
  assert.doesNotMatch(await snippet(host(2)), new RegExp(secret.id));
});

test('setting someone’s role to none removes them, even when they no longer share a trip', async (t) => {
  const { owner, host } = await setup(t);
  const note = await create(owner);
  const roles = (changes) => shareNote(owner, note.id, changes);
  assert.equal((await roles([{ user_id: 2, role: 'editor' }, { user_id: 3, role: 'viewer' }])).status, 200);
  assert.equal((await host(2).request('GET', '/note', {}, { id: note.id })).status, 200);
  assert.equal((await roles([{ user_id: 2, role: 'none' }, { user_id: 3, role: 'editor' }])).status, 200);
  assert.deepEqual((await owner.request('GET', '/collaborators', {}, { note_id: note.id })).data.collaborators
    .map((item) => [item.user_id, item.role]), [[3, 'editor']]);
  assert.equal((await host(2).request('GET', '/note', {}, { id: note.id })).status, 404);
  assert.equal((await roles([{ user_id: 2, role: 'owner' }])).status, 400);
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Shared' })).data;
  await owner.request('POST', '/folder', { action: 'bulk_roles', folder_id: folder.id, changes: [{ user_id: 2, role: 'viewer' }] });
  await owner.request('POST', '/folder', { action: 'bulk_roles', folder_id: folder.id, changes: [{ user_id: 2, role: 'none' }] });
  assert.deepEqual((await owner.request('POST', '/folder', { action: 'collaborators', folder_id: folder.id })).data.collaborators, []);
});

test('a link may point at a heading, and an embed brings the text only of a note the reader may open', async (t) => {
  const { owner, host } = await setup(t);
  const kyoto = await create(owner, { title: 'Kyoto',
    content: '# Kyoto\n## Getting there\nTake the JR.\n```\n# not a heading\n```\n## Food' });
  const plan = await create(owner, { title: 'Plan',
    content: `See [[${kyoto.id}#Getting there|Kyoto › Getting there]].\n\n![[${kyoto.id}]]` });
  const targets = (await owner.request('GET', '/link-targets', {}, { q: 'kyo', headings: '1' })).data.notes;
  assert.deepEqual(targets[0].headings, ['Kyoto', 'Getting there', 'Food']);
  assert.equal((await owner.request('GET', '/link-targets', {}, { q: 'kyo' })).data.notes[0].headings, undefined);
  assert.equal((await owner.request('GET', '/reference', {}, { ref: kyoto.id, embed: '1' })).data.content, kyoto.content);
  assert.equal((await owner.request('GET', '/reference', {}, { ref: kyoto.id })).data.content, undefined);
  assert.deepEqual((await host(2).request('GET', '/reference', {}, { ref: kyoto.id, embed: '1' })).data,
    { reference: kyoto.id, unavailable: true });
  const [backlink] = (await owner.request('GET', '/backlinks', {}, { note_id: kyoto.id })).data.notes;
  assert.deepEqual([backlink.id, backlink.snippet], [plan.id, 'See Kyoto › Getting there.']);
  await link(owner, kyoto); await link(owner, plan);
  const viaTrip = await host(2).request('POST', '/trip', { action: 'reference', trip_id: 10, ref: kyoto.id, embed: true });
  assert.equal(viaTrip.data.content, kyoto.content);
});

test('unlinked mentions find a title as written text, and linking them edits only notes the reader may edit', async (t) => {
  const { owner, host } = await setup(t);
  const tips = await create(owner, { title: 'Japan tips', content: 'IC cards.' });
  const plan = await create(owner, { title: 'Plan',
    content: 'Read japan tips first.\nThen `Japan tips` in code, and Japan tipsy.\nJapan tips again.' });
  await create(owner, { title: 'Linked', content: `Already [[${tips.id}|Japan tips]], and Japan tips.` });
  const cjk = await create(owner, { title: '东京', content: '先去东京再说' });
  const list = async (h, note = tips) => (await h.request('GET', '/backlinks', {}, { note_id: note.id })).data;
  const found = await list(owner);
  assert.deepEqual(found.mentions.map((item) => [item.id, item.snippet, item.can_link]), [[plan.id, 'Read japan tips first.', true]]);
  assert.equal(found.notes.length, 1);
  assert.equal((await owner.request('GET', '/backlinks', {}, { note_id: (await create(owner, { title: '先去' })).id })).data.mentions[0].id,
    cjk.id);
  for (const note of [plan, tips]) await shareNote(owner, note.id, [{ user_id: 2, role: 'viewer' }]);
  assert.equal((await list(host(2))).mentions[0].can_link, false);
  assert.equal((await host(2).request('POST', '/link-mentions', { note_id: plan.id, target_id: tips.id })).status, 403);
  assert.equal((await owner.request('POST', '/link-mentions', { note_id: plan.id, target_id: tips.id })).data.linked, 2);
  const linked = (await owner.request('GET', '/note', {}, { id: plan.id })).data.content;
  assert.equal(linked,
    `Read [[${tips.id}|japan tips]] first.\nThen \`Japan tips\` in code, and Japan tipsy.\n[[${tips.id}|Japan tips]] again.`);
  assert.deepEqual((await list(owner)).mentions, []);
});

test('version history keeps the note as it stood before each stretch of editing, and a restore can itself be undone', async (t) => {
  const { owner, host, db } = await setup(t);
  const note = await create(owner, { content: 'First draft.' });
  const save = async (content) => {
    const current = (await owner.request('GET', '/note', {}, { id: note.id })).data;
    const saved = await owner.request('POST', '/save', { ...current, content }); assert.equal(saved.status, 200); return saved.data;
  };
  const age = (minutes) => db.prepare('UPDATE notes SET updated_at = ?, burst_at = ? WHERE id = ?')
    .run(new Date(Date.now() - minutes * 60000).toISOString(), new Date(Date.now() - minutes * 60000).toISOString(), note.id);
  const versions = async (h = owner) => (await h.request('GET', '/history', {}, { note_id: note.id })).data;
  await save('Second draft.');
  assert.deepEqual((await versions()).versions, []);
  age(30); await save('Third draft.');
  let history = await versions();
  assert.equal(history.versions.length, 1);
  assert.deepEqual(history.versions[0].editors, [{ id: 1, name: 'Tangerine' }]);
  const kept = (await owner.request('GET', '/version', {}, { note_id: note.id, id: history.versions[0].id })).data;
  assert.equal(kept.content, 'Second draft.');
  // Co-editing counts the same way: the first change after a quiet spell keeps what came before.
  await shareNote(owner, note.id, [{ user_id: 2, role: 'editor' }, { user_id: 3, role: 'viewer' }]);
  age(11);
  const b = await collabClient(host(2), note.id);
  b.doc.getText('content').insert(0, 'Edited. '); assert.equal((await b.sync()).status, 200);
  history = await versions();
  assert.deepEqual(history.versions.map((item) => item.length), [12, 13]);
  assert.deepEqual(history.current.editors, [{ id: 2, name: 'sherwin' }]);
  assert.equal((await host(3).request('GET', '/history', {}, { note_id: note.id })).status, 403);
  assert.equal((await host(3).request('GET', '/version', {}, { note_id: note.id, id: kept.id })).status, 403);
  const current = (await owner.request('GET', '/note', {}, { id: note.id })).data;
  const restored = await owner.request('POST', '/restore', { note_id: note.id, version_id: kept.id, version: current.version });
  assert.equal(restored.data.content, 'Second draft.');
  assert.equal(b.text(), 'Edited. Third draft.');
  await b.sync(); assert.equal(b.text(), 'Second draft.');
  history = await versions();
  assert.equal((await owner.request('GET', '/version', {}, { note_id: note.id, id: history.versions[0].id })).data.content,
    'Edited. Third draft.');
  assert.equal((await owner.request('POST', '/restore', { note_id: note.id, version_id: kept.id, version: current.version })).status, 409);
});

test('history thins out with age, and an image a kept version shows stays readable from it', async (t) => {
  const { owner, db } = await setup(t);
  const note = await create(owner, { content: 'Now.' });
  const insert = db.prepare(`INSERT INTO note_versions (id, note_id, edited_at, editors, title, icon, properties, content)
    VALUES (?, ?, ?, '[]', 'Japan transport', NULL, '[]', ?)`);
  const at = (days, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600000).toISOString();
  [[0, 1], [0, 2], [3, 1], [3, 2], [40, 0], [40, 1], [400, 0]].forEach(([days, hours], index) =>
    insert.run(`v${index}`, note.id, at(days, hours), `Version ${index}`));
  insert.run('picture', note.id, at(0, 3), '![map](https://example.com/map.png)');
  const ids = (await owner.request('GET', '/history', {}, { note_id: note.id })).data.versions.map((item) => item.id);
  assert.deepEqual(ids, ['v0', 'v1', 'picture', 'v2', 'v4']);
  assert.equal((await owner.request('GET', '/asset', {}, { note_id: note.id, source: 'https://example.com/map.png' })).status, 404);
  const fromVersion = await owner.request('GET', '/asset', {}, { note_id: note.id, source: 'https://example.com/map.png',
    version_id: 'picture' });
  assert.notEqual(fromVersion.status, 404);
});

test('a body too large for one request arrives in parts, readable only by the person who sent them', async (t) => {
  const { owner, host } = await setup(t);
  const content = '长'.repeat(60000);
  const encoded = Buffer.from(JSON.stringify({ title: 'Long read', content, tags: [] })).toString('base64');
  const slices = (text) => Array.from({ length: Math.ceil(text.length / bodyPartChars) }, (_, part) =>
    ({ part, parts: Math.ceil(text.length / bodyPartChars), data: text.slice(part * bodyPartChars, (part + 1) * bodyPartChars) }));
  const send = (h, id) => Promise.all(slices(encoded).map((slice) => h.request('POST', '/part', { id, ...slice })));
  const id = '00000000-0000-4000-8000-000000000001';
  assert.ok((await send(owner, id)).every((result) => result.status === 200));
  assert.equal((await host(2).request('POST', '/save', { parts_id: id })).status, 400);
  await send(owner, id);
  const saved = await owner.request('POST', '/save', { parts_id: id });
  assert.equal(saved.data.content, content);
  assert.equal((await owner.request('POST', '/save', { parts_id: id })).status, 400);
  assert.equal((await owner.request('POST', '/part', { id, part: 0, parts: 99, data: 'AAAA' })).status, 400);
  // A trip page sends its parts through the companion, whose stamp names the sender.
  await link(owner, saved.data, 10, 'snapshot');
  const member = host(2); const tripId = '00000000-0000-4000-8000-000000000002';
  const snapshot = Buffer.from(JSON.stringify({ action: 'snapshot_save', trip_id: 10, note_id: saved.data.id, version: 1,
    title: 'Long read', content: `${content}!`, actor_id: 1 })).toString('base64');
  await Promise.all(slices(snapshot).map((slice) =>
    member.request('POST', '/trip', { action: 'part', trip_id: 10, id: tripId, ...slice })));
  const result = await member.request('POST', '/trip', { parts_id: tripId });
  assert.equal(result.data.content, `${content}!`);
});

test('a deleted note drops its co-editing log at once and is deleted permanently after 30 days', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner, { content: 'Suica' });
  const client = await collabClient(owner, note.id);
  client.doc.getText('content').insert(0, 'Buy '); await client.sync({ anchor: 1 });
  assert.equal(count(db, 'note_crdt', 'note_id = ?', note.id), 1);
  assert.equal(count(db, 'note_presence', 'note_id = ?', note.id), 1);
  await deleteNote(owner, note.id);
  for (const table of ['note_crdt', 'note_updates', 'note_presence']) assert.equal(count(db, table, 'note_id = ?', note.id), 0, table);
  assert.equal(db.prepare('SELECT archived FROM notes WHERE id = ?').get(note.id).archived, 1);

  // Opening any note to edit deletes permanently, at most every ten minutes, the notes deleted more than 30 days ago.
  db.prepare('UPDATE notes SET archived_at = ? WHERE id = ?').run(new Date(Date.now() - KEPT_MS - DAY_MS).toISOString(), note.id);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60 * 1000 });
  await collabClient(owner, (await create(owner, { title: 'Other' })).id);
  assert.equal(count(db, 'notes', 'id = ?', note.id), 0);
});

test('joining folds the update log into the document, and an unchanged cursor is not rewritten', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner, { content: '' });
  const a = await collabClient(owner, note.id);
  for (let i = 0; i < 5; i += 1) { a.doc.getText('content').insert(0, 'x'); await a.sync({ anchor: 1 }); }
  assert.equal(count(db, 'note_updates', 'note_id = ?', note.id), 5);
  const seen = db.prepare('SELECT seen_at FROM note_presence WHERE note_id = ? AND client_id = ?').get(note.id, a.doc.clientID).seen_at;
  await a.sync({ anchor: 1 });
  assert.equal(db.prepare('SELECT seen_at FROM note_presence WHERE note_id = ? AND client_id = ?').get(note.id, a.doc.clientID).seen_at,
    seen);
  const b = await collabClient(owner, note.id);
  assert.equal(count(db, 'note_updates', 'note_id = ?', note.id), 0); assert.equal(b.text(), 'xxxxx');
  a.doc.getText('content').insert(0, 'y'); await a.sync(); await b.sync(); assert.equal(b.text(), 'yxxxxx');
});

test('deleting a removed snapshot permanently takes its own co-editing rows and versions, not another trip’s', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner, { content: 'Frozen' });
  await link(owner, note, 10, 'snapshot'); await link(owner, note, 20, 'snapshot');
  for (const trip of [10, 20]) {
    const client = await collabClient(owner, note.id, trip);
    client.doc.getText('content').insert(0, 'Edited '); assert.equal((await client.sync()).status, 200);
  }
  db.prepare("INSERT INTO note_versions (id, note_id, edited_at, title, content) VALUES ('v10', ?, '2026-01-01', 'T', 'old')")
    .run(`trip:10:${note.id}`);
  assert.equal((await unlink(owner, note.id)).status, 200);
  assert.ok(count(db, 'note_versions', 'note_id = ?', `trip:10:${note.id}`) >= 1, 'kept while it can be recovered');
  assert.equal((await deletedDelete(owner, note.id)).status, 200);
  for (const table of ['note_crdt', 'note_updates', 'note_versions']) {
    assert.equal(count(db, table, 'note_id = ?', `trip:10:${note.id}`), 0, table);
  }
  assert.equal(count(db, 'note_crdt', 'note_id = ?', `trip:20:${note.id}`), 1);
});

test('one person holds at most two bodies’ worth of unclaimed parts', async (t) => {
  const { owner, host } = await setup(t);
  const part = (h, id, index) => h.request('POST', '/part', { id, part: index, parts: 24, data: 'AAAA' });
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  for (const id of ids.slice(0, 2)) for (let index = 0; index < 24; index += 1) assert.equal((await part(owner, id, index)).status, 200);
  assert.equal((await part(owner, ids[0], 3)).status, 200, 'resending a part replaces it');
  assert.equal((await part(owner, ids[2], 0)).status, 429);
  assert.equal((await part(host(2), ids[2], 0)).status, 200);
});

test('the library list carries no note text, and search still finds and quotes it', async (t) => {
  const { owner } = await setup(t); await create(owner);
  const listed = (await owner.request('GET', '/notes', {}, {})).data.notes;
  assert.equal(listed.length, 1); assert.equal(listed[0].content, undefined); assert.equal(listed[0].title, 'Japan transport');
  const found = (await owner.request('GET', '/notes', {}, { q: 'spare' })).data.notes;
  assert.equal(found.length, 1); assert.equal(found[0].content, undefined); assert.match(found[0].snippet, /spare/);
});

test('a version counts its size in UTF-8 bytes, image icon included', async (t) => {
  const { owner, db } = await setup(t);
  const icon = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;
  const note = await create(owner, { title: '京都', content: '寺院と紅葉', icon });
  db.prepare('UPDATE notes SET updated_at = ?, burst_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), new Date(Date.now() - 20 * 60 * 1000).toISOString(), note.id);
  await owner.request('POST', '/save', { id: note.id, version: note.version, title: '京都', content: '寺院' });
  const { bytes } = db.prepare('SELECT bytes FROM note_versions WHERE note_id = ?').get(note.id);
  assert.equal(bytes, Buffer.byteLength('京都') + Buffer.byteLength('寺院と紅葉') + Buffer.byteLength('[]') + icon.length);
});

test('access checks see folder changes at once, whoever made them', async (t) => {
  const { owner, host } = await setup(t); const member = host(2);
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Japan' })).data;
  const note = await create(owner, { folder_id: folder.id });
  await owner.request('POST', '/folder', { action: 'bulk_roles', folder_id: folder.id, changes: [{ user_id: 2, role: 'viewer' }] });
  assert.equal((await member.request('GET', '/folders')).data[0].icon, null);
  await owner.request('POST', '/folder', { action: 'icon', folder_id: folder.id, icon: '🗾' });
  assert.equal((await member.request('GET', '/folders')).data[0].icon, '🗾');
  assert.equal((await member.request('GET', '/note', {}, { id: note.id })).status, 200);
  const other = (await owner.request('POST', '/folder', { action: 'create', name: 'Private' })).data;
  await owner.request('POST', '/folder', { action: 'move', folder_id: folder.id, parent_id: other.id });
  assert.equal((await member.request('GET', '/folders')).data.find((item) => item.id === folder.id).parent_id, other.id);
});

test('a deleted note waits in Recently deleted with its files and history, and comes back where it was', async (t) => {
  const { owner, host, db } = await setup(t);
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Japan' })).data;
  const source = (await upload(owner)).data.source;
  const note = await create(owner, { folder_id: folder.id, content: `Station\n\n![exit](${source})` });
  db.prepare("INSERT INTO note_versions (id, note_id, edited_at, title, content) VALUES ('v1', ?, ?, 'Old', 'Older text')")
    .run(note.id, new Date().toISOString());
  await deleteNote(owner, note.id);
  assert.equal((await owner.request('GET', '/note', {}, { id: note.id })).status, 404);

  const [listed] = (await owner.request('GET', '/deleted')).data;
  assert.equal(listed.id, note.id); assert.equal(listed.content, undefined);
  assert.equal(Date.parse(listed.purge_at) - Date.parse(listed.deleted_at), KEPT_MS);
  const read = (await owner.request('GET', '/deleted', {}, { id: note.id })).data;
  assert.match(read.content, /Station/); assert.equal(read.archived_at, undefined);
  assert.deepEqual((await host(2).request('GET', '/deleted')).data, []);
  assert.equal((await host(2).request('GET', '/deleted', {}, { id: note.id })).status, 404);
  assert.equal((await host(2).request('POST', '/deleted', { action: 'recover', id: note.id })).status, 404);

  // Past the grace window its image and history still stay, because it can still come back.
  age(db, 'released_at', source.split('/').at(-1), 60 * 60 * 1000);
  await create(owner, { title: 'Sweep' }); await upload(owner, { parts: 1 });
  assert.equal(count(db, 'note_versions', 'note_id = ?', note.id), 1);
  assert.equal(count(db, 'note_assets', 'id = ?', source.split('/').at(-1)), 1);

  const recovered = await owner.request('POST', '/deleted', { action: 'recover', id: note.id });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.folder_id, folder.id);
  assert.equal(recovered.data.archived_at, undefined);
  assert.equal((await owner.request('GET', '/asset', {}, { note_id: note.id, source })).status, 200);
  assert.deepEqual((await owner.request('GET', '/deleted')).data, []);
  assert.equal((await owner.request('POST', '/deleted', { action: 'recover', id: note.id })).status, 404);
});

test('a recovered note goes to the top of the library when its folder is gone', async (t) => {
  const { owner } = await setup(t);
  const folder = (await owner.request('POST', '/folder', { action: 'create', name: 'Gone' })).data;
  const note = await create(owner, { folder_id: folder.id });
  await deleteNote(owner, note.id);
  assert.equal((await owner.request('POST', '/folder', { action: 'archive', folder_id: folder.id })).status, 200);
  assert.equal((await owner.request('POST', '/deleted', { action: 'recover', id: note.id })).data.folder_id, null);
});

test('deleting permanently removes the note with its history and sharing, and only from Recently deleted', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner);
  await shareNote(owner, note.id, [{ user_id: 2, role: 'viewer' }]);
  db.prepare("INSERT INTO note_versions (id, note_id, edited_at, title, content) VALUES ('v1', ?, ?, 'Old', 'x')")
    .run(note.id, new Date().toISOString());
  assert.equal((await owner.request('POST', '/deleted', { action: 'delete', id: note.id })).status, 404,
    'a live note is not in Recently deleted');
  await deleteNote(owner, note.id);
  assert.equal((await owner.request('POST', '/deleted', { action: 'delete', id: note.id })).status, 200);
  for (const table of ['notes', 'note_versions', 'note_collaborators']) {
    const column = table === 'notes' ? 'id' : 'note_id';
    assert.equal(count(db, table, `${column} = ?`, note.id), 0, table);
  }
});

test('the library removes only a live reference; a snapshot stays the trip’s, through unlinking and deleting the original', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner, { content: 'Frozen text' });
  await link(owner, note, 10, 'live');
  assert.equal((await owner.request('POST', '/trip', { action: 'snapshot_convert', trip_id: 10, note_id: note.id })).status, 200);
  const links = (await owner.request('POST', '/trip', { action: 'links', note_id: note.id })).data;
  assert.deepEqual(links.map((item) => item.mode), ['snapshot']);
  const refused = await owner.request('POST', '/trip', { action: 'unlink', trip_id: 10, note_id: note.id, mode: 'live' });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /own snapshot/);
  await deleteNote(owner, note.id);
  const [kept] = (await readTrip(owner)).data.notes;
  assert.equal(kept.mode, 'snapshot'); assert.equal(kept.content, 'Frozen text'); assert.equal(kept.archived_at, undefined);
  assert.equal(count(db, 'trip_note_snapshots', 'note_id = ?', note.id), 1);
  // The trip's own page still removes it, into the trip's Recently deleted.
  assert.equal((await unlink(owner, note.id)).status, 200);
  assert.equal((await deletedDelete(owner, note.id)).status, 200);
  assert.equal(count(db, 'trip_note_snapshots', 'note_id = ?', note.id), 0);
});

test('a note removed from a trip waits in the trip’s Recently deleted with its threads and folder, then comes back', async (t) => {
  const { owner, host, db } = await setup(t); const note = await create(owner, { content: 'Frozen text' });
  await link(owner, note, 10, 'snapshot');
  const folder = (await owner.request('POST', '/trip', { action: 'folder_create', trip_id: 10, name: 'Kyoto' })).data;
  await owner.request('POST', '/trip', { action: 'folder_move_note', trip_id: 10, note_id: note.id, folder_id: folder.id });
  await owner.request('POST', '/trip', { action: 'comment_add', trip_id: 10, note_id: note.id, body: 'Bring cash' });
  assert.equal((await unlink(owner, note.id)).status, 200);
  assert.deepEqual((await readTrip(owner)).data.notes, []);
  assert.equal(db.prepare('SELECT removed_by FROM trip_note_links WHERE note_id = ?').get(note.id).removed_by, 1);

  const [listed] = (await deleted(owner)).data;
  assert.equal(listed.id, note.id); assert.equal(listed.mode, 'snapshot'); assert.equal(listed.title, note.title);
  assert.equal(listed.content, undefined);
  assert.equal((await deleted(owner, 10, { note_id: note.id })).data.content, 'Frozen text');
  assert.equal((await deleted(host(3), 10)).status, 403, 'only trip members who may edit see it');
  const again = await link(owner, note, 10, 'snapshot');
  assert.equal(again.status, 409); assert.match(again.data.error, /Recently deleted/);

  const back = await deletedRecover(owner, note.id);
  assert.equal(back.status, 200); assert.equal(back.data.folder_id, folder.id); assert.equal(back.data.content, 'Frozen text');
  assert.equal((await owner.request('POST', '/trip', { action: 'comments', trip_id: 10, note_id: note.id })).data[0].body, 'Bring cash');
  assert.deepEqual((await deleted(owner)).data, []);
  assert.equal(db.prepare('SELECT removed_at FROM trip_note_links WHERE note_id = ?').get(note.id).removed_at, null);
});

test('bringing back a live reference follows the rule for sharing one live', async (t) => {
  const { owner, host } = await setup(t); const member = host(2); const note = await create(owner);
  await link(owner, note, 10, 'live');
  assert.equal((await unlink(member, note.id)).status, 200);
  const refused = await deletedRecover(member, note.id);
  assert.equal(refused.status, 403); assert.match(refused.data.error, /Only the author/);
  assert.equal((await deletedRecover(owner, note.id)).status, 200);
  assert.equal((await readTrip(member)).data.notes[0].mode, 'live');
});

test('a trip’s removed notes are deleted permanently after 30 days', async (t) => {
  const { owner, db } = await setup(t); const note = await create(owner);
  await link(owner, note, 10, 'snapshot');
  await unlink(owner, note.id);
  const past = new Date(Date.now() - KEPT_MS - DAY_MS).toISOString();
  db.prepare('UPDATE trip_note_links SET removed_at = ? WHERE note_id = ?').run(past, note.id);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 25 * 60 * 1000 });
  assert.deepEqual((await deleted(owner)).data, []);
  for (const table of ['trip_note_links', 'trip_note_snapshots']) {
    assert.equal(count(db, table, 'note_id = ?', note.id), 0, table);
  }
});
