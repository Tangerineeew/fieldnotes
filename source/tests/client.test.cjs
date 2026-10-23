'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const Y = require('yjs');
let bundle;

before(async () => {
  const result = await build({ entryPoints: [path.join(__dirname, '../client/main.tsx')], bundle: true, write: false,
    outfile: 'app.js', format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles.find((file) => file.path.endsWith('app.js')).text;
});

async function until(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Expected UI state was not reached');
}

async function ui(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://trek.test/plugin-frame/fieldnotes/',
    ...(options.referrer ? { referrer: options.referrer } : {}),
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  // CodeMirror measures layout; jsdom has none, so report empty geometry.
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.Range.prototype.getClientRects = () => []; window.Range.prototype.getBoundingClientRect = rect;
  const doc = window.document;
  const calls = [];
  const confirmations = [];
  let current = { id: '11111111-1111-1111-1111-111111111111', title: 'Japan tips', content: '# Bring an IC card',
    tags: ['Japan'], owner_id: 1, visibility: 'private', can_edit: true, version: 1, updated_at: '2026-09-21', ...options.note };
  let context = { tripId: options.trip ? '10' : null, userId: 1, locale: options.locale || 'en' };
  // In-memory /collab server backed by a real Yjs document, mirroring server/collab.cjs.
  let server = null; let serverSeq = 0; const queued = []; const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
  const materialize = () => {
    const properties = [...server.getMap('properties').values()].sort((a, b) => a.position - b.position)
      .map(({ position, ...property }) => property);
    current = { ...current, title: server.getText('title').toString(), content: server.getText('content').toString(), properties,
      icon: server.getMap('meta').get('icon') ?? null, version: current.version + 1 };
  };
  function collab(body) {
    if (body.action === 'leave') return { left: true };
    // Like the server's respond(): an expected failure is a 200 envelope, because TREK's bridge drops error bodies.
    if (options.collabError) return { error: options.collabError.message, status: options.collabError.code };
    if (!server) {
      server = new Y.Doc();
      server.transact(() => {
        server.getText('title').insert(0, current.title); server.getText('content').insert(0, current.content);
        (current.properties || []).forEach((property, position) => server.getMap('properties').set(property.id, { ...property, position }));
        if (current.icon) server.getMap('meta').set('icon', current.icon);
      });
    }
    if (body.action === 'join') return { seq: serverSeq, state: toB64(Y.encodeStateAsUpdate(server)), updates: [],
      presence: options.peers || [], me: { name: 'Tangerine', color: '#8b5cf6' }, version: current.version };
    for (const update of body.updates) Y.applyUpdate(server, Buffer.from(update, 'base64'));
    if (body.updates.length) { serverSeq += 1; materialize(); }
    return { seq: serverSeq, updates: queued.splice(0), presence: options.peers || [] };
  }
  function remote(change) {
    const captured = []; const listener = (update) => captured.push(update);
    server.on('update', listener); change(server); server.off('update', listener);
    queued.push(toB64(Y.mergeUpdates(captured))); serverSeq += 1; materialize();
  }
  let onContext;
  window.trek = {
    context,
    onContext(callback) { onContext = callback; callback(context); return () => {}; },
    async invoke(sub, init) {
      calls.push({ sub, ...init });
      if (options.invoke) { const result = await options.invoke(sub, init); if (result !== undefined) return result; }
      if (sub === '/trip-intent') return null;
      if (sub.startsWith('/notes')) return { notes: [current], has_more: false };
      if (sub.startsWith('/note?')) return current;
      if (sub === '/trips') return [{ id: 10, title: 'Japan trip' }];
      if (sub.startsWith('/collaborators')) return { collaborators: [], candidates: [] };
      if (sub === '/collab') return collab(init.body);
      if (sub === '/save' || sub === '/trip-note') { current = { ...current, ...init.body, id: current.id,
        version: current.version + 1 }; return current; }
      if (sub === '/trip' && init.body.action === 'days') return [{ id: 101, date: '2026-10-01', title: 'Tokyo' }];
      if (sub === '/trip' && init.body.action === 'list') return { trip: { id: 10, title: 'Japan trip' },
        notes: [{ ...current, mode: 'live' }] };
      return { ok: true };
    },
    async confirm(input) { confirmations.push(input); return options.confirm !== false; },
    navigate(to) { calls.push({ navigate: to }); },
    openExternal(url) { calls.push({ external: url }); },
  };
  window.eval(bundle);
  await until(() => calls.some((call) => call.sub.startsWith('/notes') || call.sub.startsWith('/public')
    || call.sub === '/trip' && call.body?.action === 'list'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await until(() => doc.querySelector('.fn-layout')?.getAttribute('aria-busy') === 'false');
  if (doc.querySelector('.fn-note-row')) await until(() => !doc.querySelector('.fn-note-row').disabled);
  function click(label) {
    const element = [...doc.querySelectorAll('button')].find((button) => button.textContent === label);
    assert.ok(element, `Missing button: ${label}`); assert.equal(element.disabled, false); element.click();
  }
  function input(selector, value) {
    const node = doc.querySelector(selector); assert.ok(node, selector);
    const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function select(selector, value) {
    const node = doc.querySelector(selector); assert.ok(node, selector); node.value = value;
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  return { doc, window, calls, confirmations, click, input, select, remote, collabDoc: () => server, note: () => current,
    changeContext(fields) { context = { ...context, ...fields }; onContext(context); } };
}

test('client creates a note through the declared route without client user identity', async (t) => {
  const app = await ui(t);
  app.click('New note'); await until(() => app.doc.querySelector('#title'));
  app.input('#title', '上海旅行'); app.input('#content', '## 交通\n准备交通卡');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('[role="status"]').textContent === 'Saved.');
  const request = app.calls.find((call) => call.sub === '/save');
  assert.equal(request.body.title, '上海旅行'); assert.equal(request.body.content, '## 交通\n准备交通卡');
  assert.equal(request.body.tags, undefined); assert.equal(app.doc.querySelector('#tags'), null);
  assert.equal(request.body.user_id, undefined);
});

test('folder action menu exposes deletion without horizontal gestures', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? [folder] : undefined });
  const menuButton = app.doc.querySelector('[title="Folder actions"]'); assert.ok(menuButton); menuButton.click();
  await until(() => app.doc.querySelector('[role="menuitem"]'));
  assert.equal(app.doc.querySelector('[role="menuitem"]').textContent.trim(), 'Delete');
  assert.equal(app.doc.querySelectorAll('[role="menu"]').length, 1);
  app.doc.body.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
  await until(() => app.doc.querySelectorAll('[role="menu"]').length === 0);
  app.doc.querySelectorAll('[title="Folder actions"]')[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  await until(() => app.doc.querySelectorAll('[role="menu"]').length === 1);
  assert.equal(app.doc.querySelector('.is-swiped'), null);
});

const treeFolders = [
  { id: '33333333-3333-3333-3333-333333333331', owner_id: 1, parent_id: null, name: '日本', visibility: 'private', role: 'editor',
    public_path: false, can_manage: true },
  { id: '33333333-3333-3333-3333-333333333332', owner_id: 1, parent_id: null, name: '韩国', visibility: 'private', role: 'editor',
    public_path: false, can_manage: true },
  { id: '33333333-3333-3333-3333-333333333333', owner_id: 1, parent_id: '33333333-3333-3333-3333-333333333331', name: '交通',
    visibility: 'private', role: 'editor', public_path: false, can_manage: true },
];
function drag(app, type, node) {
  const event = new app.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } });
  node.dispatchEvent(event); return event;
}
const sidebarRow = (app, name) => [...app.doc.querySelectorAll('.fn-folder-item')].find((item) => item.textContent.includes(name));

test('folder tree lists each subfolder directly below its parent', async (t) => {
  const app = await ui(t, { locale: 'zh', invoke: (sub) => sub === '/folders' ? treeFolders : undefined });
  await until(() => app.doc.querySelectorAll('.fn-folder-item').length === 3);
  const rows = [...app.doc.querySelectorAll('.fn-folder-item')];
  // zh collation is pinyin-based: 韩国 (hán) sorts before 日本 (rì); 交通 stays nested under 日本.
  assert.deepEqual(rows.map((row) => row.querySelector('.fn-folder-label').textContent), ['韩国', '日本', '交通']);
  assert.deepEqual(rows.map((row) => row.style.getPropertyValue('--folder-depth')), ['0', '0', '1']);
});

test('folders drag onto folders or the library root, never into their own subtree', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? treeFolders : undefined });
  await until(() => app.doc.querySelectorAll('.fn-folder-item').length === 3);
  const japan = sidebarRow(app, '日本');
  drag(app, 'dragstart', japan.querySelector('.fn-folder-row'));
  await until(() => japan.classList.contains('is-dragging'));
  assert.equal(drag(app, 'dragover', sidebarRow(app, '交通')).defaultPrevented, false);
  const korea = sidebarRow(app, '韩国');
  assert.equal(drag(app, 'dragover', korea).defaultPrevented, true);
  await until(() => korea.classList.contains('is-drop-target') && korea.querySelector('.fn-drop-arrow'));
  drag(app, 'drop', korea);
  await until(() => app.calls.some((call) => call.body?.action === 'move'));
  assert.deepEqual({ ...app.calls.find((call) => call.body?.action === 'move').body }, { action: 'move', folder_id: treeFolders[0].id,
    parent_id: treeFolders[1].id });
  await until(() => app.doc.querySelector('.fn-layout').getAttribute('aria-busy') === 'false');
  drag(app, 'dragstart', sidebarRow(app, '交通').querySelector('.fn-folder-row'));
  await until(() => sidebarRow(app, '交通').classList.contains('is-dragging'));
  const root = app.doc.querySelector('.fn-library-row'); drag(app, 'dragover', root); drag(app, 'drop', root);
  await until(() => app.calls.filter((call) => call.body?.action === 'move').length === 2);
  assert.equal(app.calls.filter((call) => call.body?.action === 'move')[1].body.parent_id, null);
});

test('sort menu requests the chosen order and remembers it', async (t) => {
  const app = await ui(t);
  app.doc.querySelector('.fn-sort-button').click();
  await until(() => app.doc.querySelector('.fn-sort-menu'));
  app.click('Name');
  await until(() => app.calls.some((call) => call.sub.includes('sort=name&order=asc')));
  assert.equal(JSON.parse(app.window.localStorage.getItem('fieldnotes:sort')).key, 'name');
  assert.ok(app.calls.find((call) => call.sub.includes('sort=name')).sub.includes('offset=0'));
});

test('selected folder permissions keep icon and visibility in explicit field groups', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub === '/folders') return [folder];
    if (sub === '/folder' && init?.body?.action === 'collaborators') return { collaborators: [], candidates: [] };
    return undefined;
  } });
  app.click('Japan'); await until(() => app.doc.querySelector('.fn-folder-access'));
  const fields = app.doc.querySelectorAll('.fn-folder-settings > .fn-setting-field');
  assert.equal(fields.length, 2);
  assert.equal(fields[0].querySelector('label').getAttribute('for'), 'folder-icon');
  assert.equal(fields[1].querySelector('label').getAttribute('for'), 'folder-visibility');
});

test('Trip Fieldnotes empty state opens the library to add a note', async (t) => {
  const app = await ui(t, { trip: true, invoke: (sub, init) => sub === '/trip' && init?.body?.action === 'list'
    ? { trip: { id: 10, title: 'Japan trip' }, notes: [] } : undefined });
  assert.match(app.doc.querySelector('.fn-empty h2').textContent, /Create a note here/);
  const openLibrary = [...app.doc.querySelectorAll('.fn-empty button')].find((button) => button.textContent === 'Open library');
  assert.ok(openLibrary);
  openLibrary.click();
  assert.ok(app.calls.some((call) => call.navigate === '/plugins/fieldnotes'));
});

test('Trip Fieldnotes starts a linked note in the trusted library editor', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Transport', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { trip: true, invoke: (sub, init) => {
    if (sub === '/trip' && init?.body?.action === 'folders') return [folder];
    if (sub === '/trip' && init?.body?.action === 'list') return { trip: { id: 10, title: 'Japan trip' }, notes: [] };
    return undefined;
  } });
  app.click('Transport'); await until(() => app.doc.querySelector('.fn-content-context')?.textContent.includes('Transport'));
  app.doc.querySelector('[aria-label="New note for this trip"]').click();
  await until(() => app.calls.some((call) => call.sub === '/trip' && call.body?.action === 'begin_note'));
  const request = app.calls.find((call) => call.sub === '/trip' && call.body?.action === 'begin_note');
  assert.equal(request.body.trip_folder_id, '22222222-2222-2222-2222-222222222222');
  await until(() => app.calls.some((call) => call.navigate === '/plugins/fieldnotes'));
});

test('trusted library editor atomically saves and returns a trip-created note', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub === '/trip-intent'
    ? { tripId: 10, tripFolderId: '22222222-2222-2222-2222-222222222222', title: 'Japan trip' } : undefined });
  await until(() => app.doc.querySelector('.fn-trip-create-context'));
  assert.equal(app.doc.querySelector('#visibility'), null);
  app.input('#title', 'Airport transfer'); app.input('#content', 'Take the express train.');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.calls.some((call) => call.sub === '/trip-note'));
  const request = app.calls.find((call) => call.sub === '/trip-note');
  assert.equal(request.body.trip_id, 10);
  assert.equal(request.body.trip_folder_id, '22222222-2222-2222-2222-222222222222');
  assert.equal(request.body.title, 'Airport transfer');
  await until(() => app.calls.some((call) => call.navigate === '/trips/10?tab=plugin%3Afieldnotes-trip'));
});

test('switching library scope clears the old search text', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/public') ? { notes: [], has_more: false } : undefined });
  app.input('#search', 'Tokyo');
  app.doc.querySelectorAll('[role="tab"]')[1].click();
  await until(() => app.doc.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected') === 'true');
  assert.equal(app.doc.querySelector('#search').value, '');
});

test('note detail provides a back action and per-person collaborator role picker', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/collaborators')
    ? { collaborators: [], candidates: [{ id: 2, display_name: 'Ari' }] } : undefined });
  app.doc.querySelector('.fn-note-row').click(); await until(() => app.doc.querySelector('[aria-label="Back to library"]'));
  assert.equal(app.doc.querySelector('.fn-folders'), null);
  assert.ok(app.doc.querySelector('.fn-layout').classList.contains('fn-layout-editor'));
  assert.equal(app.doc.querySelector('.fn-folder-access'), null);
  assert.equal(app.doc.querySelector('[aria-label="Note navigation"] h2').textContent, 'Notes');
  assert.equal(app.doc.querySelectorAll('input[type="checkbox"]').length, 1);
  assert.equal(app.doc.querySelectorAll('.fn-person-role-select').length, 1);
  assert.ok(app.doc.querySelector('.fn-mobile-back'));
  app.doc.querySelector('.fn-mobile-back').click(); await until(() => app.doc.querySelector('.fn-note-row'));
});

test('Escape asks before discarding unsaved folder permission changes', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { confirm: false, invoke: (sub, init) => {
    if (sub === '/folders') return [folder];
    if (sub === '/folder' && init?.body?.action === 'collaborators') return {
      collaborators: [{ user_id: 2, role: 'editor', user: { id: 2, display_name: 'Ari' } }], candidates: [],
    };
    return undefined;
  } });
  app.doc.querySelector('[title="Folder actions"]').click();
  await until(() => [...app.doc.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes('Permissions')));
  [...app.doc.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('Permissions')).click();
  await until(() => app.doc.querySelector('.fn-modal .fn-collaborator-list select'));
  const role = app.doc.querySelector('.fn-modal .fn-collaborator-list select');
  role.value = 'viewer'; role.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => app.confirmations.length === 1);
  assert.ok(app.doc.querySelector('.fn-modal'));
});

test('multiple collaborators are added in one request with individually staged roles', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/collaborators')
    ? { collaborators: [], candidates: [{ id: 2, display_name: 'Ari' }, { id: 3, display_name: 'Bea' }] } : undefined });
  app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelectorAll('.fn-person-role-row').length === 2);
  const rows = [...app.doc.querySelectorAll('.fn-person-role-row')];
  rows[0].querySelector('input').click();
  rows[0].querySelector('select').value = 'viewer';
  rows[0].querySelector('select').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  rows[1].querySelector('input').click();
  rows[1].closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'));
  const request = app.calls.find((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.changes)), [
    { user_id: 2, role: 'viewer' }, { user_id: 3, role: 'editor' },
  ]);
  assert.equal(app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'add'), false);
});

test('collaborator roles can be staged and saved together', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/collaborators')
    ? { collaborators: [{ user_id: 2, role: 'editor', user: { id: 2, display_name: 'Ari' } }], candidates: [] } : undefined });
  app.doc.querySelector('.fn-note-row').click(); await until(() => app.doc.querySelector('.fn-collaborators select'));
  app.select('.fn-collaborators select', 'viewer');
  assert.equal(app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'), false);
  app.click('Save changes');
  await until(() => app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'));
  const request = app.calls.find((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles');
  assert.equal(JSON.stringify(request.body.changes), JSON.stringify([{ user_id: 2, role: 'viewer' }]));
});

test('reference and snapshot share confirmations are explicit and UI sends their mode', async (t) => {
  const app = await ui(t); app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('#trip'));
  app.select('#trip', '10'); await until(() => app.doc.querySelectorAll('#day option').length === 2);
  await until(() => !app.doc.querySelector('fieldset').disabled);
  app.select('#day', '101'); app.select('#mode', 'snapshot'); app.click('Add to trip');
  await until(() => app.calls.some((call) => call.sub === '/link'));
  const call = app.calls.find((item) => item.sub === '/link');
  assert.equal(call.body.mode, 'snapshot'); assert.equal(call.body.trip_id, 10); assert.equal(call.body.day_id, '101');
  assert.match(app.confirmations[0].message, /even if you delete the original or leave/);
});

test('canceling sharing never writes a link', async (t) => {
  const app = await ui(t, { confirm: false }); app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('#trip')); app.select('#trip', '10');
  await until(() => !app.doc.querySelector('fieldset').disabled); app.click('Add to trip');
  await until(() => app.confirmations.length === 1);
  assert.equal(app.calls.filter((call) => call.sub === '/link').length, 0);
});

// A trip page whose /trip route keeps one note's discussion in memory, like the server's comment actions.
async function tripUi(t, fields = {}) {
  let comments = []; let seq = 0;
  let note = { id: '11111111-1111-1111-1111-111111111111', title: 'Japan tips', content: 'Buy an IC card. Keep a spare IC card.',
    owner_id: 1, version: 1, updated_at: '2026-09-21', mode: 'live', can_snapshot: true, ...fields };
  const app = await ui(t, { trip: true, note,
    invoke: (sub, init) => {
      const body = init?.body || {};
      if (sub !== '/trip') return undefined;
      if (body.action === 'list') return { trip: { id: 10, title: 'Japan trip' }, notes: [note] };
      if (body.action === 'comments') return comments;
      if (body.action === 'comment_add') {
        seq += 1;
        comments = [...comments, { id: `00000000-0000-4000-8000-00000000000${seq}`, parent_id: body.parent_id || null, author_id: 1,
          author: { id: 1, display_name: 'Tangerine', color: '#ec4899' },
          body: body.body, quote: body.quote || null, prefix: body.prefix || null,
          suffix: body.suffix || null, created_at: '2026-10-23T08:00:00Z', updated_at: '2026-10-23T08:00:00Z', resolved_at: null,
          resolved_by: null }];
        return comments;
      }
      if (body.action === 'snapshot_save') note = { ...note, title: body.title, content: body.content, version: note.version + 1 };
      if (body.action === 'snapshot_convert') note = { ...note, mode: 'snapshot' };
      if (['snapshot_save', 'snapshot_convert'].includes(body.action)) return note;
      return undefined;
    } });
  app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('.fn-markdown')?.textContent.includes('IC card'));
  return app;
}
const button = (app, label) => app.doc.querySelector(`[aria-label="${label}"]`);

test('a trip note fills the page and swaps folder actions for note actions', async (t) => {
  const app = await tripUi(t);
  assert.equal(app.doc.querySelector('.fn-library'), null);
  assert.equal(app.doc.querySelector('.fn-trip-folder-placement'), null);
  for (const label of ['Refresh', 'New note for this trip', 'Open library']) assert.equal(button(app, label), null, label);
  for (const label of ['Comments', 'Convert to snapshot', 'Remove from trip']) assert.ok(button(app, label), label);
  assert.equal(button(app, 'Edit snapshot'), null);
  assert.equal(app.doc.body.textContent.includes('Copy excerpt'), false);
  assert.equal(button(app, 'Back to notes').textContent, '');
  button(app, 'Back to notes').click(); await until(() => app.doc.querySelector('.fn-library'));
  assert.ok(button(app, 'Refresh'));
});

test('a live reference becomes a snapshot only after confirmation', async (t) => {
  const app = await tripUi(t);
  button(app, 'Convert to snapshot').click();
  await until(() => app.calls.some((call) => call.body?.action === 'snapshot_convert'));
  assert.match(app.confirmations.at(-1).message, /keeps its own copy/);
  await until(() => button(app, 'Edit snapshot'));
  assert.equal(button(app, 'Convert to snapshot'), null);
});

test('trip editors edit a snapshot in place without library-only fields', async (t) => {
  const app = await tripUi(t, { mode: 'snapshot', version: 7 });
  assert.equal(button(app, 'Convert to snapshot'), null);
  button(app, 'Edit snapshot').click(); await until(() => app.doc.querySelector('#title'));
  assert.equal(app.doc.querySelector('#visibility'), null);
  assert.equal(app.doc.body.textContent.includes('Changes apply only to this trip’s copy'), true);
  app.input('#title', 'IC cards for this trip'); app.click('Save snapshot');
  await until(() => app.calls.some((call) => call.body?.action === 'snapshot_save'));
  const request = app.calls.find((call) => call.body?.action === 'snapshot_save').body;
  assert.equal(request.version, 7); assert.equal(request.title, 'IC cards for this trip'); assert.equal(request.folder_id, undefined);
  await until(() => app.doc.querySelector('.fn-detail-header h2')?.textContent === 'IC cards for this trip');
});

test('comments open in a side panel, for the whole note or a selected passage', async (t) => {
  const app = await tripUi(t);
  button(app, 'Comments').click(); await until(() => app.doc.querySelector('.fn-comment-panel'));
  assert.match(app.doc.querySelector('.fn-comment-empty').textContent, /Select text/);
  app.input('.fn-comment-new textarea', 'Worth it for the airport train.'); app.click('Comment');
  await until(() => app.doc.querySelectorAll('.fn-comment-thread').length === 1);
  assert.equal(app.calls.find((call) => call.body?.action === 'comment_add').body.quote, undefined);
  // Selecting the second "IC card" quotes it with enough context to tell it from the first.
  const text = app.doc.querySelector('.fn-markdown p').firstChild; const at = text.data.lastIndexOf('IC card');
  const range = app.doc.createRange(); range.setStart(text, at); range.setEnd(text, at + 'IC card'.length);
  app.window.getSelection().removeAllRanges(); app.window.getSelection().addRange(range);
  app.doc.dispatchEvent(new app.window.Event('selectionchange'));
  await until(() => app.doc.querySelector('.fn-quote-button')); app.doc.querySelector('.fn-quote-button').click();
  await until(() => app.doc.querySelector('.fn-comment-new .fn-comment-quote'));
  app.input('.fn-comment-new textarea', 'Get the Suica one.'); app.click('Comment');
  await until(() => app.doc.querySelectorAll('.fn-comment-thread').length === 2);
  const quoted = app.calls.filter((call) => call.body?.action === 'comment_add')[1].body;
  assert.equal(quoted.quote, 'IC card'); assert.equal(quoted.prefix, 'Buy an IC card. Keep a spare '); assert.match(quoted.suffix, /^\./);
  assert.equal(button(app, 'Comments').querySelector('.fn-badge').textContent, '2');
  const avatar = app.doc.querySelector('.fn-comment-avatar');
  assert.equal(avatar.textContent, 'T'); assert.equal(avatar.style.getPropertyValue('--peer'), '#ec4899');
});

async function openEditor(app) {
  app.doc.querySelector('.fn-note-row').click();
  await until(() => [...app.doc.querySelectorAll('button')].some((button) => button.textContent === 'Edit'));
  app.click('Edit'); await until(() => app.doc.querySelector('#content-editor .cm-content'));
  const content = app.doc.querySelector('#content-editor .cm-content');
  const view = app.doc.querySelector('#content-editor').liveEditorView; assert.ok(view, 'CodeMirror view is reachable');
  const caret = (text, offset = 0) => { view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(text) + offset } }); };
  return { content, view, caret };
}

const synced = (app) => app.calls.filter((call) => call.sub === '/collab' && call.body.action === 'sync'
  && call.body.updates.length).length;

test('live editor renders Markdown but reveals and edits its syntax at the caret', async (t) => {
  const app = await ui(t, { note: { content: '# Bring an IC card\n\nBring **cash** too.' } });
  const { content, view, caret } = await openEditor(app);
  assert.equal(content.querySelector('.fn-md-h1')?.textContent, 'Bring an IC card');
  assert.equal(content.textContent.includes('**'), false);
  caret('cash', 1);
  await until(() => content.textContent.includes('**cash**'));
  assert.equal(content.querySelector('.fn-md-h1').textContent, 'Bring an IC card');
  caret('Bring an', 0);
  await until(() => content.querySelector('.fn-md-h1').textContent === '# Bring an IC card');
  view.dispatch({ changes: { from: 0, to: 2 } });
  await until(() => !content.querySelector('.fn-md-h1'));
  // Edits reach the shared document by themselves; there is no save round-trip any more.
  await until(() => app.note().content === 'Bring an IC card\n\nBring **cash** too.');
  assert.equal(app.calls.some((call) => call.sub === '/save'), false);
});

test('notes gain typed properties that save with the note and render as a property panel', async (t) => {
  const app = await ui(t, { note: { properties: [{ id: 'fare', name: 'Fare', type: 'number', value: 170 }] } });
  app.doc.querySelector('.fn-note-row').click(); await until(() => app.doc.querySelector('.fn-props'));
  assert.equal(app.doc.querySelector('.fn-prop-row dd').textContent, '170');
  assert.equal(app.doc.querySelector('.fn-workspace').textContent.includes('v1'), false);
  app.click('Edit'); await until(() => app.doc.querySelector('.fn-prop-editor'));
  app.click('+ Add property'); await until(() => app.doc.querySelector('.fn-prop-menu'));
  app.click('Select'); await until(() => app.doc.querySelector('.fn-prop-option-input'));
  app.input('.fn-prop-option-input', 'Doing');
  app.doc.querySelector('.fn-prop-option-input').dispatchEvent(new app.window.KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('.fn-prop-option.is-selected'));
  await until(() => app.note().properties.length === 2);
  const [fare, status] = app.note().properties;
  assert.equal(fare.value, 170); assert.equal(status.type, 'select'); assert.equal(status.value, status.options[0].id);
  assert.equal(status.options[0].name, 'Doing');
  app.click('Done');
  await until(() => app.doc.querySelector('.fn-props .fn-prop-chip')?.textContent === 'Doing');
  assert.ok(app.calls.some((call) => call.sub === '/collab' && call.body.action === 'leave'));
});

test('live editor formatting shortcuts and task checkboxes rewrite the Markdown source', async (t) => {
  const app = await ui(t, { note: { content: 'Pack light\n\n- [ ] Buy Suica' } });
  const { content, view } = await openEditor(app);
  view.focus(); view.dispatch({ selection: { anchor: 5, head: 10 } });
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => view.state.doc.toString().startsWith('Pack **light**'));
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => view.state.doc.toString().startsWith('## Pack **light**'));
  view.contentDOM.blur(); await until(() => content.querySelector('.fn-md-task'));
  content.querySelector('.fn-md-task').dispatchEvent(new app.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await until(() => app.note().content === '## Pack **light**\n\n- [x] Buy Suica');
});

test('co-editing shows other editors and merges their changes into the open editor', async (t) => {
  const peers = [{ client_id: 42, user_id: 2, name: 'Sherwin', color: '#ec4899', cursor: null }];
  const app = await ui(t, { note: { title: 'Japan tips', content: 'Suica' }, peers });
  const { view } = await openEditor(app);
  await until(() => app.doc.querySelector('.fn-collab-avatar')?.title === 'Sherwin');
  assert.match(app.doc.querySelector('.fn-collab-people').textContent, /Others editing: 1/);
  app.remote((doc) => { doc.getText('content').insert(0, 'Buy '); doc.getText('title').insert(10, ' 2026'); });
  await until(() => view.state.doc.toString() === 'Buy Suica');
  await until(() => app.doc.querySelector('#title').value === 'Japan tips 2026');
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' today' } });
  await until(() => synced(app) > 0 && app.note().content === 'Buy Suica today');
});

test('rapid typing is merged into at most one sync per second to respect the shared host quota', async (t) => {
  const app = await ui(t, { note: { content: '' } });
  const { view } = await openEditor(app);
  const started = Date.now();
  for (let i = 0; i < 30; i += 1) { view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
    await new Promise((resolve) => setTimeout(resolve, 50)); }
  await until(() => app.note().content === 'x'.repeat(30));
  const elapsed = (Date.now() - started) / 1000;
  assert.ok(synced(app) <= Math.ceil(elapsed) + 1, `${synced(app)} syncs in ${elapsed.toFixed(1)}s`);
});

test('note list shows modified and created dates and highlights the one being sorted by', async (t) => {
  const app = await ui(t, { note: { created_at: '2025-03-01T08:00:00Z', updated_at: new Date().toISOString(), icon: '🚃' } });
  const row = app.doc.querySelector('.fn-note-row');
  assert.equal(row.querySelector('.fn-note-row-icon').textContent, '🚃');
  const [modified, created] = row.querySelectorAll('.fn-note-dates > span');
  assert.match(modified.textContent, /^Modified Today \d/); assert.match(created.textContent, /^Created Mar 1, 2025$/);
  assert.equal(modified.classList.contains('is-sorted'), true); assert.equal(created.classList.contains('is-sorted'), false);
  app.doc.querySelector('.fn-sort-button').click(); await until(() => app.doc.querySelector('.fn-sort-menu'));
  app.click('Date created');
  await until(() => app.doc.querySelector('.fn-note-dates > span:last-child')?.classList.contains('is-sorted'));
});

test('an emoji icon chosen while co-editing reaches the note and heads its page', async (t) => {
  const app = await ui(t);
  await openEditor(app);
  app.click('+ Add icon'); await until(() => app.doc.querySelector('.fn-icon-picker-panel'));
  [...app.doc.querySelectorAll('.fn-icon-picker-grid button')].find((button) => button.textContent === '🗾').click();
  await until(() => app.note().icon === '🗾');
  app.click('Done');
  await until(() => app.doc.querySelector('.fn-note-hero')?.textContent === '🗾');
});

test('a rejected collaboration update stops the session and offers to rejoin', async (t) => {
  const app = await ui(t, { collabError: { code: 403, message: 'Edit permission required.' } });
  app.doc.querySelector('.fn-note-row').click();
  await until(() => [...app.doc.querySelectorAll('button')].some((button) => button.textContent === 'Edit'));
  app.click('Edit');
  await until(() => app.doc.querySelector('.fn-collab-failure'));
  assert.match(app.doc.querySelector('.fn-collab-failure').textContent, /Edit permission required/);
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === 'Rejoin'));
});

test('live editor renders tables as blocks and never loads unresolved image sources', async (t) => {
  const app = await ui(t, { note: { content: 'Fares\n\n| Line | Yen |\n|---|---|\n| JR | 170 |\n\n![map](https://evil.test/map.png)' } });
  const { content, caret } = await openEditor(app);
  assert.equal(content.querySelector('.fn-md-table td')?.textContent, 'JR');
  assert.equal(app.doc.querySelectorAll('#content-editor img[src^="https://"]').length, 0);
  assert.equal(content.querySelector('.fn-md-image-pending')?.textContent, 'map');
  caret('| JR', 2);
  await until(() => !content.querySelector('.fn-md-table') && content.textContent.includes('| JR | 170 |'));
});


test('Markdown strips active content and keeps image requests behind resolved resources', async (t) => {
  const content = '# Heading\n\n**Safe**\n\n<script>window.pwned=1</script><iframe src="https://evil.test"></iframe>\n\n' +
    '<img src="https://evil.test/pixel" onerror="window.pwned=1">\n\n![photo](https://evil.test/photo.jpg)\n\n' +
    '[bad](javascript:alert(1))\n\n[good](https://example.com)';
  const app = await ui(t, { note: { content } }); app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('.fn-markdown'));
  const article = app.doc.querySelector('.fn-markdown');
  assert.equal(article.querySelectorAll('script,iframe,[onerror],[style]').length, 0);
  assert.equal(article.querySelectorAll('img[src^="https://"]').length, 0);
  assert.equal(article.querySelector('img')?.getAttribute('src').startsWith('data:image/'), true);
  assert.equal(article.querySelectorAll('a[href^="javascript:"]').length, 0); assert.equal(app.window.pwned, undefined);
  assert.equal(article.querySelector('strong').textContent, 'Safe');
  article.querySelector('a[href="https://example.com"]').click();
  assert.equal(app.calls.find((call) => call.external).external, 'https://example.com/');
});

test('client resolves wikilinks and opens the referenced note without exposing its source URL', async (t) => {
  const app = await ui(t, {
    note: { content: 'Read [[Japan tips]] next.' },
    invoke: (sub) => sub.startsWith('/reference') ? { reference: 'Japan tips', id: '11111111-1111-1111-1111-111111111111',
      title: 'Japan tips' } : undefined,
  });
  app.doc.querySelector('.fn-note-row').click(); await until(() => app.doc.querySelector('.fn-markdown a[href^="fieldnotes://note/"]'));
  assert.equal(app.doc.querySelector('.fn-markdown a').textContent, 'Japan tips');
  app.doc.querySelector('.fn-markdown a').click();
  assert.ok(app.calls.some((call) => call.sub.startsWith('/note?')));
});

test('client renders a resolved internal image resource without loading its source URL', async (t) => {
  const source = 'fieldnotes://trip-file/10/5';
  const app = await ui(t, {
    note: { content: `![station](${source})` },
    invoke: (sub) => sub.startsWith('/asset') ? { source, data_url: 'data:image/png;base64,cG5n' } : undefined,
  });
  app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('.fn-markdown img[src^="data:image/png"]'));
  assert.equal(app.doc.querySelector('.fn-markdown img').getAttribute('alt'), 'station');
  assert.equal(app.doc.querySelector('.fn-markdown img').getAttribute('src'), 'data:image/png;base64,cG5n');
});

test('an image picked in the editor uploads in parts, lands at the caret and renders before any save', async (t) => {
  const source = 'fieldnotes://asset/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const app = await ui(t, { note: { content: 'Station exit' }, invoke: (sub) => sub === '/upload' ? { source } : undefined });
  const { content, caret } = await openEditor(app);
  caret('Station exit', 'Station exit'.length);
  const picker = app.doc.querySelector('.fn-image-picker');
  const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
  Object.defineProperty(picker, 'files', { value: [new app.window.File([gif], 'exit A3.gif', { type: 'image/gif' })] });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await until(() => content.querySelector('img.fn-md-image[src^="data:image/gif"]'));
  const upload = app.calls.find((call) => call.sub === '/upload');
  assert.deepEqual({ part: upload.body.part, parts: upload.body.parts, data: upload.body.data },
    { part: 0, parts: 1, data: gif.toString('base64') });
  await until(() => app.note().content === `Station exit\n![exit A3](${source})\n`);
});

test('typing / opens a filterable block menu that rewrites the line from the keyboard', async (t) => {
  const app = await ui(t, { note: { content: 'Tokyo' } });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type('\n'); type('/');
  await until(() => app.doc.querySelector('.fn-editor-menu'));
  const labels = () => [...app.doc.querySelectorAll('.fn-editor-menu-title')].map((node) => node.textContent);
  assert.equal(labels()[0], 'Image');
  assert.deepEqual([...app.doc.querySelectorAll('.fn-editor-menu-section')].map((node) => node.textContent), ['Media', 'Basic blocks']);
  type('zz');
  await until(() => app.doc.querySelector('.fn-editor-menu-empty')?.textContent === 'No matching blocks');
  view.dispatch({ changes: { from: view.state.selection.main.head - 2, to: view.state.selection.main.head } });
  type('quo');
  await until(() => labels().join() === 'Quote');
  assert.equal(app.doc.querySelector('.fn-editor-menu-title mark').textContent, 'Quo');
  view.dispatch({ changes: { from: view.state.selection.main.head - 3, to: view.state.selection.main.head } });
  type('he');
  await until(() => labels().join() === 'Heading 1,Heading 2,Heading 3');
  view.dispatch({ changes: { from: view.state.selection.main.head - 2, to: view.state.selection.main.head } });
  type('quo');
  await until(() => labels().join() === 'Quote');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-editor-menu'));
  assert.equal(view.state.doc.toString(), 'Tokyo\n> ');
  type(' x'); assert.equal(app.doc.querySelector('.fn-editor-menu'), null);
});

test('right-click opens the editor menu; its image item asks for a file and Escape closes it', async (t) => {
  const app = await ui(t, { note: { content: 'Tokyo' } });
  const { content } = await openEditor(app);
  let picked = 0; app.doc.querySelector('.fn-image-picker').click = () => { picked += 1; };
  content.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await until(() => app.doc.querySelector('.fn-editor-menu'));
  const item = (label) => [...app.doc.querySelectorAll('.fn-editor-menu button')]
    .find((button) => (button.getAttribute('aria-label') || button.querySelector('.fn-editor-menu-title')?.textContent) === label);
  assert.equal(item('Paste').disabled, true); assert.equal(item('Copy').disabled, true);
  item('Heading 2').click();
  await until(() => app.note().content === '## Tokyo');
  content.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await until(() => app.doc.querySelector('.fn-editor-menu'));
  item('Image').click();
  assert.equal(picked, 1); assert.equal(app.doc.querySelector('.fn-editor-menu'), null);
  content.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('.fn-editor-menu'));
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-editor-menu'));
  const native = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
  content.dispatchEvent(native);
  assert.equal(native.defaultPrevented, false); assert.equal(app.doc.querySelector('.fn-editor-menu'), null);
});

test('an image a co-editor inserts is fetched and shown without reopening the note', async (t) => {
  const source = 'fieldnotes://asset/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const peers = [{ client_id: 42, user_id: 2, name: 'Sherwin', color: '#ec4899', cursor: null }];
  const app = await ui(t, { note: { content: 'Map' }, peers,
    invoke: (sub) => sub.startsWith('/asset') ? { source, data_url: 'data:image/png;base64,cG5n' } : undefined });
  const { content, view } = await openEditor(app);
  app.remote((doc) => doc.getText('content').insert(3, `\n![map](${source})`));
  await until(() => view.state.doc.toString().includes(source));
  await until(() => content.querySelector('img.fn-md-image[src^="data:image/png"]'));
  assert.equal(app.calls.filter((call) => call.sub.startsWith('/asset')).length, 1);
});

test('an image pasted while another action is still running is uploaded, not dropped', async (t) => {
  const source = 'fieldnotes://asset/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let release;
  const app = await ui(t, { note: { content: 'Station exit' }, invoke: async (sub) => {
    if (sub === '/upload') return { source };
    if (sub === '/note-settings') await new Promise((resolve) => { release = resolve; });
  } });
  const { content } = await openEditor(app);
  app.select('#visibility', 'public');
  await until(() => typeof release === 'function');
  const picker = app.doc.querySelector('.fn-image-picker');
  const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
  Object.defineProperty(picker, 'files', { value: [new app.window.File([gif], 'exit.gif', { type: 'image/gif' })] });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await until(() => content.querySelector('img.fn-md-image[src^="data:image/gif"]'));
  release();
});

test('an image that cannot load says why instead of showing an empty frame', async (t) => {
  const source = 'https://images.example.test/view.jpg';
  const app = await ui(t, { note: { content: `![view](${source})` }, invoke: (sub) => {
    if (sub.startsWith('/asset')) return { error: 'Image host is not allowed. Paste the image itself, or ask an admin to allow this host.', status: 403 };
  } });
  app.doc.querySelector('.fn-note-row').click();
  await until(() => app.doc.querySelector('.fn-markdown em')?.textContent.includes('this site is not allowed'));
  assert.equal(app.doc.querySelector('.fn-markdown img'), null);
});

test('server conflicts stay visible and preserve the unsaved draft', async (t) => {
  const app = await ui(t, { invoke: (sub) => { if (sub === '/save') return { error: 'This note changed. Reload before saving.', status: 409 }; } });
  app.click('New note'); await until(() => app.doc.querySelector('#title'));
  app.input('#title', 'Unsaved');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('[role="alert"]'));
  assert.match(app.doc.querySelector('[role="alert"]').textContent, /changed/);
  assert.equal(app.doc.querySelector('#title').value, 'Unsaved');
});

test('server failures are shown in the reader language, with translated parameters', async (t) => {
  const app = await ui(t, { locale: 'de', invoke: (sub) => sub === '/save'
    ? { error: 'Invalid value: title.', status: 400, template: 'Invalid value: {field}.', params: { field: 'title' } } : undefined });
  app.click('Neue Notiz'); await until(() => app.doc.querySelector('#title'));
  app.input('#title', 'Entwurf');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('[role="alert"]'));
  assert.equal(app.doc.querySelector('[role="alert"]').textContent, 'Ungültiger Wert: Titel.');
});

test('host locale and theme context changes do not discard an in-progress draft', async (t) => {
  const app = await ui(t); app.click('New note'); await until(() => app.doc.querySelector('#title'));
  app.input('#title', 'Keep my draft'); app.changeContext({ locale: 'zh-CN', theme: 'dark' });
  await until(() => app.doc.documentElement.lang === 'zh-CN');
  assert.equal(app.doc.querySelector('#title').value, 'Keep my draft');
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === '保存笔记'));
});

test('supported TREK locales translate the main editor actions', async (t) => {
  const app = await ui(t, { locale: 'de' }); app.click('Neue Notiz'); await until(() => app.doc.querySelector('#content-editor'));
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === 'Notiz speichern'));
  app.changeContext({ locale: 'zh-TW' }); await until(() => app.doc.documentElement.lang === 'zh-TW');
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === '儲存筆記'));
});
