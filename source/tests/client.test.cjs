'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const Y = require('yjs');
// How long Recently deleted keeps a note.
const KEPT_MS = 30 * 24 * 3600 * 1000;
let bundle;

before(async () => {
  const result = await build({ entryPoints: [path.join(__dirname, '../client/main.tsx')], bundle: true, write: false,
    outfile: 'app.js', format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty' } });
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
      if (options.invoke) { const result = await options.invoke(sub, init, doc); if (result !== undefined) return result; }
      if (sub === '/trip-intent') return null;
      if (sub.startsWith('/notes')) return { notes: [current], has_more: false };
      if (sub.startsWith('/note?')) return current;
      if (sub === '/trips') return [{ id: 10, title: 'Japan trip' }];
      if (sub.startsWith('/collaborators')) return { collaborators: [], candidates: [] };
      if (sub === '/collab') return collab(init.body);
      if (sub === '/save' || sub === '/trip-note') { current = { ...current, ...init.body, id: current.id,
        version: current.version + 1 }; return current; }
      // A trip page co-edits a snapshot through the companion's /trip route.
      if (sub === '/trip' && init.body.action === 'collab') return collab({ ...init.body, action: init.body.op });
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
  await until(() => doc.querySelector('.fn-layout, .fn-finder-card')?.getAttribute('aria-busy') === 'false');
  // A button is named by its text, or by its label when it shows only an icon.
  const named = (label) => [...doc.querySelectorAll('button')].find((button) => button.textContent === label
    || (!button.textContent.trim() && button.getAttribute('aria-label') === label));
  function click(label) {
    const element = named(label);
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
  // Opens a note the way a person would: its row is previewed first, and a second click opens it.
  async function open(title) {
    const pick = (selector) => [...doc.querySelectorAll(selector)].find((row) => !title || row.textContent.includes(title));
    await until(() => pick('.fn-finder-row[data-kind="note"]'));
    pick('.fn-finder-row[data-kind="note"]').click();
    await until(() => pick('.fn-finder-row[data-kind="note"][aria-current]'));
    pick('.fn-finder-row[data-kind="note"]').click();
    await until(() => doc.querySelector('.fn-layout-reader'));
  }
  // Right-clicks a Finder row by name, or the empty part of a column when given one.
  async function menu(target) {
    const node = typeof target === 'string'
      ? [...doc.querySelectorAll('.fn-finder-row')].find((row) => row.textContent.includes(target)) : target;
    assert.ok(node, `Missing Finder target: ${target}`);
    node.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await until(() => doc.querySelector('.fn-context-menu'));
    return [...doc.querySelectorAll('.fn-context-menu [role^="menuitem"]')];
  }
  // New notes start from the library's context menu, whose first item is "New note" in every language.
  async function newNote() {
    (await menu(doc.querySelector('.fn-finder-column')))[0].click(); await until(() => doc.querySelector('#title'));
  }
  return { doc, window, calls, confirmations, click, input, select, remote, open, menu, newNote, collabDoc: () => server,
    note: () => current,
    changeContext(fields) { context = { ...context, ...fields }; onContext(context); } };
}

test('client creates a note through the declared route without client user identity', async (t) => {
  const app = await ui(t);
  await app.newNote();
  app.input('#title', '上海旅行'); app.input('#content', '## 交通\n准备交通卡');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('.fn-toast').textContent === 'Saved.');
  const request = app.calls.find((call) => call.sub === '/save');
  assert.equal(request.body.title, '上海旅行'); assert.equal(request.body.content, '## 交通\n准备交通卡');
  assert.equal(request.body.tags, undefined); assert.equal(app.doc.querySelector('#tags'), null);
  assert.equal(request.body.user_id, undefined);
});

test('a new note started in a folder or from the toolbar leaves without asking until something is typed', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? [folder] : undefined });
  (await app.menu('Japan')).find((item) => item.textContent === 'New note').click();
  await until(() => app.doc.querySelector('#title'));
  app.doc.querySelector('.fn-reader-back').click(); await until(() => app.doc.querySelector('.fn-finder-card'));
  app.doc.querySelector('.fn-finder-toolbar .fn-new-note').click(); await until(() => app.doc.querySelector('#title'));
  app.input('#title', 'Draft'); app.doc.querySelector('.fn-reader-back').click();
  await until(() => app.confirmations.length === 1);
  assert.equal(app.calls.some((call) => call.sub === '/save'), false);
});

test('Finder rows and empty space have their own context menus', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const listed = { id: '11111111-1111-1111-1111-111111111111', owner_id: 1, title: 'Kyoto', content: 'Temples', version: 1,
    updated_at: '2026-01-01T00:00:00Z' };
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? [folder] : sub.startsWith('/notes') ? { notes: [listed] }
    : sub.startsWith('/note?') ? listed : undefined });
  assert.equal(app.doc.querySelector('.fn-folder-menu-button'), null);
  const labels = (items) => items.map((item) => item.textContent.trim());

  assert.deepEqual(labels(await app.menu('Japan')), ['Open', 'New note', 'New folder', 'Permissions', 'Delete']);
  assert.ok(app.doc.querySelector('.fn-finder-row.is-context')?.textContent.includes('Japan'));
  assert.equal(app.doc.activeElement, app.doc.querySelector('.fn-context-menu [role="menuitem"]'));
  app.doc.querySelector('.fn-context-menu').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-context-menu'));

  assert.deepEqual(labels(await app.menu('Kyoto')), ['Open', 'Copy as Markdown', 'Edit', 'Sharing', 'Delete note']);
  await until(() => app.doc.querySelector('.fn-preview h2')?.textContent === 'Kyoto');
  app.doc.body.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-context-menu'));

  const blank = await app.menu(column(app, 0));
  assert.deepEqual(labels(blank), ['New note', 'New folder', 'Import Markdown or ZIP…', 'Import a folder…', 'Name', 'Date modified',
    'Date created']);
  assert.deepEqual(blank.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent), ['Date modified']);
  blank.find((item) => item.textContent.includes('New folder')).click();
  await until(() => app.doc.querySelector('.fn-new-folder-popover #new-folder-name'));
});

test('a finger held on a Finder row opens its menu as a sheet and the tap that ends the press does nothing', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? [folder] : undefined });
  const row = [...app.doc.querySelectorAll('.fn-finder-row')].find((item) => item.textContent.includes('Japan'));
  const touch = (type) => {
    const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
    Object.defineProperty(event, 'pointerType', { value: 'touch' }); row.dispatchEvent(event);
  };
  touch('pointerdown');
  await until(() => app.doc.querySelector('.fn-menu-sheet'), 2000);
  assert.equal(app.doc.querySelector('.fn-menu-sheet-title').textContent, 'Japan');
  touch('pointerup'); row.click();
  assert.equal(row.getAttribute('aria-current'), null);
  app.doc.querySelector('.fn-menu-sheet-scrim').dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-menu-sheet'));
  row.click(); await until(() => row.getAttribute('aria-current') === 'true');
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
const column = (app, position) => app.doc.querySelector(`.fn-finder-column[data-column="${position}"]`);
const finderItem = (app, name) => [...app.doc.querySelectorAll('.fn-finder-item')].find((item) => item.textContent.includes(name));
const names = (node) => [...node.querySelectorAll('.fn-finder-row')].map((row) => row.textContent);

test('the column view lists top folders first, and a folder’s own subfolders in the next column', async (t) => {
  const app = await ui(t, { locale: 'zh', invoke: (sub) => sub === '/folders' ? treeFolders : undefined });
  await until(() => column(app, 0)?.querySelectorAll('.fn-finder-item').length === 2);
  // zh collation is pinyin-based: 韩国 (hán) sorts before 日本 (rì); 交通 lives inside 日本.
  assert.deepEqual(names(column(app, 0)).slice(0, 2), ['韩国', '日本']);
  finderItem(app, '日本').querySelector('.fn-finder-row').click();
  await until(() => column(app, 1));
  assert.deepEqual(names(column(app, 1)), ['交通']);
  assert.equal(finderItem(app, '日本').querySelector('.fn-finder-row').getAttribute('aria-current'), 'true');
  assert.deepEqual([...app.doc.querySelectorAll('.fn-finder-crumb')].map((crumb) => crumb.textContent), ['全部笔记', '日本']);
});

test('folders drag onto folders or the library root, never into their own subtree', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub === '/folders' ? treeFolders : undefined });
  await until(() => finderItem(app, '日本'));
  finderItem(app, '日本').querySelector('.fn-finder-row').click(); await until(() => finderItem(app, '交通'));
  const japan = finderItem(app, '日本');
  drag(app, 'dragstart', japan.querySelector('.fn-finder-row'));
  await until(() => japan.classList.contains('is-dragging'));
  assert.equal(drag(app, 'dragover', finderItem(app, '交通')).defaultPrevented, false);
  const korea = finderItem(app, '韩国');
  assert.equal(drag(app, 'dragover', korea).defaultPrevented, true);
  await until(() => korea.classList.contains('is-drop-target'));
  drag(app, 'drop', korea);
  await until(() => app.calls.some((call) => call.body?.action === 'move'));
  assert.deepEqual({ ...app.calls.find((call) => call.body?.action === 'move').body }, { action: 'move', folder_id: treeFolders[0].id,
    parent_id: treeFolders[1].id });
  await until(() => app.doc.querySelector('.fn-finder-card').getAttribute('aria-busy') === 'false');
  drag(app, 'dragstart', finderItem(app, '交通').querySelector('.fn-finder-row'));
  await until(() => finderItem(app, '交通').classList.contains('is-dragging'));
  const root = column(app, 0); drag(app, 'dragover', root); drag(app, 'drop', root);
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
  // The column view asks for every note at once rather than a page of them.
  assert.ok(!app.calls.find((call) => call.sub.includes('sort=name')).sub.includes('offset='));
});

test('a selected folder’s preview shows who can open it; its permissions window has icon and visibility field groups', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const sherwin = { user_id: 2, role: 'viewer', user: { id: 2, username: 'sherwin', display_name: 'Sherwin' } };
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub === '/folders') return [folder];
    if (sub === '/folder' && init?.body?.action === 'collaborators') return { collaborators: [sherwin], candidates: [] };
    return undefined;
  } });
  finderItem(app, 'Japan').querySelector('.fn-finder-row').click();
  await until(() => app.doc.querySelector('.fn-preview-people li'));
  assert.match(app.doc.querySelector('.fn-preview-folder .fn-preview-meta').textContent, /Private folder · Owner/);
  assert.equal(app.doc.querySelector('.fn-preview-people li').textContent, 'SSherwinViewer');
  assert.equal(app.doc.querySelector('.fn-preview-folder button'), null);
  (await app.menu('Japan')).find((item) => item.textContent.includes('Permissions')).click();
  await until(() => app.doc.querySelector('.fn-modal'));
  const fields = app.doc.querySelectorAll('.fn-modal-folder-settings > .fn-setting-field');
  assert.equal(fields.length, 2);
  assert.equal(fields[0].querySelector('label').getAttribute('for'), 'modal-folder-icon');
  assert.equal(fields[1].querySelector('label').getAttribute('for'), 'modal-folder-visibility');
});

test('a trip shows placeholder rows, not its empty state, until the first list arrives', async (t) => {
  let pending;
  const app = await ui(t, { trip: true, invoke: async (sub, init, doc) => {
    if (sub !== '/trip' || init?.body?.action !== 'list' || pending) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 30));
    pending = { placeholders: doc.querySelectorAll('.fn-note-skeleton li').length, empty: Boolean(doc.querySelector('.fn-finder-empty')),
      status: doc.querySelector('.fn-toast').textContent };
    return undefined;
  } });
  assert.deepEqual(pending, { placeholders: 4, empty: false, status: '' });
  assert.equal(app.doc.querySelector('.fn-note-skeleton'), null);
  assert.ok(app.doc.querySelector('.fn-finder-row[data-kind="note"]'));
});

test('an empty trip says how to add a note, and its toolbar opens the library', async (t) => {
  const app = await ui(t, { trip: true, invoke: (sub, init) => sub === '/trip' && init?.body?.action === 'list'
    ? { trip: { id: 10, title: 'Japan trip' }, notes: [] } : undefined });
  assert.match(app.doc.querySelector('.fn-finder-empty').textContent, /Create a note here/);
  app.doc.querySelector('.fn-finder-toolbar [aria-label="Open Fieldnotes library"]').click();
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
  [...app.doc.querySelectorAll('.fn-finder-row')].find((row) => row.textContent.includes('Transport')).click();
  await until(() => app.doc.querySelector('.fn-finder-crumb[aria-current]')?.textContent === 'Transport');
  app.doc.querySelector('.fn-finder-toolbar [aria-label="New note for this trip"]').click();
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

test('a note page keeps the note central with a small Finder beside it, shares in a window, and goes back to the note', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', owner_id: 1, parent_id: null, name: 'Japan', visibility: 'private',
    role: 'editor', public_path: false, can_manage: true };
  const app = await ui(t, { note: { folder_id: folder.id }, invoke: (sub) => {
    if (sub === '/folders') return [folder];
    if (sub.startsWith('/collaborators')) return { collaborators: [], candidates: [{ id: 2, display_name: 'Ari' }] };
  } });
  finderItem(app, 'Japan').querySelector('.fn-finder-row').click(); await app.open();
  const browser = app.doc.querySelector('.fn-note-browser');
  assert.equal(browser.hasAttribute('data-open'), true);
  assert.deepEqual([...browser.querySelectorAll('.fn-finder-crumb')].map((crumb) => crumb.textContent), ['All notes', 'Japan']);
  assert.equal(browser.querySelector('.fn-finder-row[aria-current="page"]').textContent, 'Japan tips');
  browser.querySelector('[aria-label="Back to parent folder"]').click();
  await until(() => names(browser.querySelector('.fn-mini-finder-list')).join() === 'Japan');
  browser.querySelector('.fn-finder-row[data-kind="folder"]').click();
  await until(() => browser.querySelector('.fn-finder-row[aria-current="page"]'));
  app.doc.querySelector('[aria-label="Hide notes"]').click();
  await until(() => !browser.hasAttribute('data-open'));
  assert.equal(JSON.parse(app.window.localStorage.getItem('fieldnotes:drawers')).tree, false);
  app.doc.querySelector('.fn-reader-share').click();
  await until(() => app.doc.querySelector('.fn-share-modal .fn-collaborator-list select'));
  assert.equal(app.doc.querySelector('.fn-share-modal [role="dialog"], .fn-share-modal').getAttribute('aria-modal'), 'true');
  assert.equal(app.doc.querySelector('.fn-share-modal .fn-collaborator-list select').value, 'none');
  assert.ok(app.doc.querySelector('.fn-share-modal #trip'));
  app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-share-modal'));
  app.doc.querySelector('.fn-reader-back').click();
  await until(() => app.doc.querySelector('.fn-finder-row[data-kind="note"][aria-current="true"]'));
  assert.equal(app.doc.querySelector('.fn-preview h2').textContent, 'Japan tips');
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
  (await app.menu('Japan')).find((item) => item.textContent.includes('Permissions')).click();
  await until(() => app.doc.querySelector('.fn-modal .fn-collaborator-list select'));
  const role = app.doc.querySelector('.fn-modal .fn-collaborator-list select');
  role.value = 'viewer'; role.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => app.confirmations.length === 1);
  assert.ok(app.doc.querySelector('.fn-modal'));
});

test('people are given, changed or denied access from one list and saved in one request', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/collaborators') ? {
    collaborators: [{ user_id: 4, role: 'editor', user: { id: 4, display_name: 'Cai' } }],
    candidates: [{ id: 2, display_name: 'Ari' }, { id: 3, display_name: 'Bea' }] } : undefined });
  await app.open(); app.doc.querySelector('.fn-reader-share').click();
  await until(() => app.doc.querySelectorAll('.fn-share-modal .fn-collaborator-list li').length === 3);
  const rows = [...app.doc.querySelectorAll('.fn-share-modal .fn-collaborator-list li')];
  assert.deepEqual(rows.map((row) => [row.textContent.match(/Cai|Ari|Bea/)[0], row.querySelector('select').value]),
    [['Cai', 'editor'], ['Ari', 'none'], ['Bea', 'none']]);
  const choose = (row, value) => { const select = row.querySelector('select'); select.value = value;
    select.dispatchEvent(new app.window.Event('change', { bubbles: true })); };
  choose(rows[0], 'none'); choose(rows[1], 'viewer'); choose(rows[2], 'editor');
  await until(() => /Unsaved changes: 3/.test(app.doc.querySelector('.fn-share-modal .fn-collaborator-bulk-actions').textContent));
  app.click('Save changes');
  await until(() => app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'));
  const request = app.calls.find((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.changes)), [
    { user_id: 4, role: 'none' }, { user_id: 2, role: 'viewer' }, { user_id: 3, role: 'editor' },
  ]);
});

test('collaborator roles can be staged and saved together', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/collaborators')
    ? { collaborators: [{ user_id: 2, role: 'editor', user: { id: 2, display_name: 'Ari' } }], candidates: [] } : undefined });
  await app.open(); app.doc.querySelector('.fn-reader-share').click();
  await until(() => app.doc.querySelector('.fn-collaborators select'));
  app.select('.fn-collaborators select', 'viewer');
  assert.equal(app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'), false);
  app.click('Save changes');
  await until(() => app.calls.some((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles'));
  const request = app.calls.find((call) => call.sub === '/collaborator' && call.body?.action === 'bulk_roles');
  assert.equal(JSON.stringify(request.body.changes), JSON.stringify([{ user_id: 2, role: 'viewer' }]));
});

test('reference and snapshot share confirmations are explicit and UI sends their mode', async (t) => {
  const app = await ui(t); await app.open(); app.doc.querySelector('.fn-reader-share').click();
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
  const app = await ui(t, { confirm: false }); await app.open(); app.doc.querySelector('.fn-reader-share').click();
  await until(() => app.doc.querySelector('#trip')); app.select('#trip', '10');
  await until(() => !app.doc.querySelector('fieldset').disabled); app.click('Add to trip');
  await until(() => app.confirmations.length === 1);
  assert.equal(app.calls.filter((call) => call.sub === '/link').length, 0);
});

// A trip page whose /trip route keeps one note's discussion in memory, like the server's comment actions.
async function tripUi(t, fields = {}, actions = {}) {
  let comments = []; let seq = 0;
  let note = { id: '11111111-1111-1111-1111-111111111111', title: 'Japan tips', content: 'Buy an IC card. Keep a spare IC card.',
    owner_id: 1, version: 1, updated_at: '2026-09-21', mode: 'live', can_snapshot: true, ...fields };
  const app = await ui(t, { trip: true, note,
    invoke: (sub, init) => {
      const body = init?.body || {};
      if (sub !== '/trip') return undefined;
      if (actions[body.action]) return actions[body.action](body);
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
  await app.open();
  await until(() => app.doc.querySelector('.fn-markdown')?.textContent.includes('IC card'));
  return app;
}
const button = (app, label) => app.doc.querySelector(`[aria-label="${label}"]`);

test('a trip note reads as a library note does, with the trip’s actions beside its title', async (t) => {
  const app = await tripUi(t);
  assert.ok(app.doc.querySelector('.fn-layout-reader'));
  for (const label of ['Refresh', 'New note for this trip', 'Open Fieldnotes library']) assert.equal(button(app, label), null, label);
  for (const label of ['Comments', 'Convert to snapshot', 'Remove from trip']) {
    assert.ok(app.doc.querySelector(`.fn-note-actions [aria-label="${label}"]`), label);
  }
  assert.equal(button(app, 'Edit snapshot'), null);
  assert.equal(app.doc.body.textContent.includes('Copy excerpt'), false);
  assert.equal(app.doc.querySelector('.fn-reader-back').textContent, 'Japan trip');
  // The note browser and the comments open on either side of the note; without room for both, one gives way to the other.
  button(app, 'Comments').click(); await until(() => app.doc.querySelector('.fn-layout-reader[data-side]'));
  app.doc.querySelector('.fn-reader-bar button').click(); await until(() => app.doc.querySelector('.fn-layout-reader[data-tree]'));
  assert.equal(app.doc.querySelector('.fn-layout-reader[data-side]'), null);
  app.doc.querySelector('.fn-reader-back').click(); await until(() => app.doc.querySelector('.fn-finder-card'));
  assert.ok(button(app, 'Refresh'));
  assert.ok(app.doc.querySelector('.fn-finder-row[data-kind="note"][aria-current]'));
});

test('a trip note’s outline docks beside it, above the comments, and stays open while the reader jumps', async (t) => {
  const app = await tripUi(t, { content: '## Before\nBuy an IC card.\n\n## Arrival\nTake the train.' });
  const outline = () => app.doc.querySelector('.fn-note-actions [aria-label="Outline"]');
  await until(() => outline());
  outline().click(); await until(() => app.doc.querySelector('.fn-outline-dock[data-open]'));
  assert.equal(outline().getAttribute('aria-pressed'), 'true');
  assert.equal(app.doc.querySelector('.fn-outline-popover'), null);
  assert.ok(app.doc.querySelector('.fn-layout-reader[data-side]'));
  button(app, 'Comments').click(); await until(() => app.doc.querySelector('.fn-comment-panel[data-open]'));
  const side = app.doc.querySelector('.fn-side-panels');
  assert.deepEqual([...side.children].map((child) => child.className), ['fn-outline-dock', 'fn-comment-panel']);
  [...app.doc.querySelectorAll('.fn-outline-panel .fn-outline-item')].find((item) => item.textContent === 'Arrival').click();
  assert.ok(app.doc.querySelector('.fn-outline-dock[data-open]'));
  app.doc.querySelector('.fn-outline-panel [aria-label="Close"]').click();
  await until(() => !app.doc.querySelector('.fn-outline-dock[data-open]'));
  assert.ok(app.doc.querySelector('.fn-comment-panel[data-open]'));
});

test('on a trip, Finder menus offer what a trip editor can do with its notes and folders', async (t) => {
  const folder = { id: '22222222-2222-2222-2222-222222222222', parent_id: null, name: 'Transport', visibility: 'private',
    role: 'editor', public_path: true, can_manage: true };
  const listed = { id: '11111111-1111-1111-1111-111111111111', owner_id: 1, title: 'IC cards', content: 'Buy one', version: 1,
    updated_at: '2026-09-21', mode: 'live', can_snapshot: true };
  const gone = { id: '33333333-3333-3333-3333-333333333333', unavailable: true, mode: 'live', folder_id: null };
  const app = await ui(t, { trip: true, invoke: (sub, init) => {
    if (sub === '/trip' && init?.body?.action === 'folders') return [folder];
    if (sub === '/trip' && init?.body?.action === 'list') return { trip: { id: 10, title: 'Japan trip' }, notes: [listed, gone] };
    return undefined;
  } });
  const labels = (items) => items.map((item) => item.textContent.trim());
  assert.deepEqual(labels(await app.menu('IC cards')), ['Open', 'Copy as Markdown', 'Convert to snapshot', 'Remove from trip']);
  app.doc.querySelector('.fn-context-menu').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(labels(await app.menu('Reference unavailable')), ['Remove from trip']);
  app.doc.querySelector('.fn-context-menu').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(labels(await app.menu('Transport')), ['Open', 'New note for this trip', 'New folder', 'Delete']);
  app.doc.querySelector('.fn-context-menu').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(labels(await app.menu(app.doc.querySelector('.fn-finder-column'))).every((label) => !label.startsWith('Import')));
});

test('a live reference becomes a snapshot only after confirmation', async (t) => {
  const app = await tripUi(t);
  button(app, 'Convert to snapshot').click();
  await until(() => app.calls.some((call) => call.body?.action === 'snapshot_convert'));
  assert.match(app.confirmations.at(-1).message, /keeps its own copy/);
  await until(() => button(app, 'Edit snapshot'));
  assert.equal(button(app, 'Convert to snapshot'), null);
});

test('trip editors edit a snapshot live, saving as they type, and read its versions through the trip', async (t) => {
  const listing = { current: { edited_at: '2026-09-21T08:00:00Z', editors: [{ id: 1, name: 'Tangerine' }], title: 'Japan tips',
    length: 37 },
    versions: [{ id: 'v1', edited_at: '2026-09-20T08:00:00Z', editors: [{ id: 2, name: 'sherwin' }], title: 'Japan tips', icon: null,
      length: 9 }] };
  const app = await tripUi(t, { mode: 'snapshot', version: 7 }, { snapshot_history: () => listing,
    snapshot_version: () => ({ id: 'v1', edited_at: '2026-09-20T08:00:00Z', title: 'Japan tips', icon: null, properties: [],
      content: 'IC cards.' }) });
  assert.equal(button(app, 'Convert to snapshot'), null);
  button(app, 'Edit snapshot').click(); await until(() => app.doc.querySelector('#content-editor .cm-content'));
  assert.equal(app.doc.querySelector('#visibility'), null);
  assert.equal([...app.doc.querySelectorAll('button')].some((item) => /Save/.test(item.textContent)), false);
  app.input('#title', 'IC cards for this trip');
  const synced = () => app.calls.find((call) => call.body?.action === 'collab' && call.body.op === 'sync' && call.body.updates?.length);
  await until(synced);
  assert.equal(synced().body.trip_id, 10); assert.equal(synced().body.note_id, '11111111-1111-1111-1111-111111111111');
  assert.equal(app.calls.some((call) => call.sub === '/collab' || call.body?.action === 'snapshot_save'), false);
  app.doc.querySelector('.fn-reader-back').click(); await until(() => app.doc.querySelector('.fn-finder-card'));
  await app.open(); await until(() => button(app, 'Version history'));
  button(app, 'Version history').click(); await until(() => app.doc.querySelector('.fn-history-modal'));
  await until(() => app.calls.some((call) => call.body?.action === 'snapshot_history'));
  assert.equal(app.calls.some((call) => call.sub.startsWith('/history')), false);
});

test('a snapshot editor finds the trip’s PDFs in the slash menu; a library note never offers them', async (t) => {
  const ticket = { source: 'fieldnotes://trip-file/10/6', name: 'Shinkansen ticket.pdf', size: 30 };
  const app = await tripUi(t, { mode: 'snapshot' }, { files: () => [ticket],
    file: (body) => body.source === ticket.source ? { source: ticket.source, data_url: PDF_URL } : undefined });
  button(app, 'Edit snapshot').click(); await until(() => app.doc.querySelector('#content-editor .cm-content'));
  await until(() => app.calls.some((call) => call.body?.action === 'files'));
  const content = app.doc.querySelector('#content-editor .cm-content');
  const view = app.doc.querySelector('#content-editor').liveEditorView;
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type('\n'); type('/'); await until(() => app.doc.querySelector('.fn-editor-menu'));
  assert.ok([...app.doc.querySelectorAll('.fn-editor-menu-section')].some((node) => node.textContent === 'From this trip'));
  type('shink');
  await until(() => app.doc.querySelector('.fn-editor-menu .is-active .fn-editor-menu-title')?.textContent === ticket.name);
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => content.querySelector('figure.fn-md-pdf'));
  assert.equal(view.state.doc.toString(), `Buy an IC card. Keep a spare IC card.\n![${ticket.name}](${ticket.source})\n`);

  const library = await ui(t, { note: { content: 'Tokyo' } });
  const editor = await openEditor(library);
  editor.view.focus(); editor.view.dispatch({ changes: { from: 5, insert: '\n/' }, selection: { anchor: 7 }, userEvent: 'input.type' });
  await until(() => library.doc.querySelector('.fn-editor-menu'));
  assert.equal([...library.doc.querySelectorAll('.fn-editor-menu-section')].some((node) => node.textContent === 'From this trip'), false);
  assert.equal(library.calls.some((call) => call.body?.action === 'files'), false);
});

test('a snapshot shows its trip’s items as cards that open in the plan, and / or [[ inserts one on a line of its own', async (t) => {
  const inari = { ref: 'place/501', kind: 'place', name: 'Fushimi Inari', category: { name: 'Shrine', icon: '⛩️', color: '#8b5cf6' },
    day: { number: 1, date: '2026-11-24' }, time: '08:00', map: 'https://www.google.com/maps/search/?api=1&query=34.96,135.77',
    link: '/trips/10?tab=plan&place=501' };
  const flight = { ref: 'booking/39', kind: 'booking', name: 'PVG → KIX', type: 'flight', status: 'pending',
    start: '2026-11-24T06:05', end: '2026-11-24T09:10', number: 'MM080', carrier: 'Peach', seat: '22E', location: null, map: null,
    from: { name: 'Shanghai Pudong', code: 'PVG', time: '06:05', date: '2026-11-24', zone: 'Asia/Shanghai' },
    to: { name: 'Osaka Kansai', code: 'KIX', time: '09:10', date: '2026-11-24', zone: 'Asia/Tokyo' },
    day: { number: 1, date: '2026-11-24' }, link: '/trips/10?tab=plan&booking=39' };
  const content = 'Buy an IC card. Keep a spare IC card.\n![[trek:place/501|Fushimi Inari]]\n![[trek:day/7|Day two]]\n\n'
    + '![[trek:booking/39|PVG → KIX]]\nSee [[trek:place/501|it]] early.';
  const app = await tripUi(t, { mode: 'snapshot', content }, { objects: (body) => ({ objects: body.refs
    ? [inari, flight].filter((card) => body.refs.includes(card.ref)) : [inari, flight] }) });
  const reader = app.doc.querySelector('.fn-markdown');
  const place = () => reader.querySelector('.fn-trek[data-kind="place"]');
  await until(() => place()?.querySelector('.fn-trek-name')?.textContent === 'Fushimi Inari');
  assert.equal(place().querySelector('.fn-trek-facts').textContent, 'Shrine · Day 1 · Tue, Nov 24 · 08:00');
  // A journey is timed by the clocks at either end: 06:05 in Shanghai to 09:10 in Osaka is two hours and five minutes.
  const journey = reader.querySelector('.fn-trek[data-kind="booking"]');
  assert.deepEqual([...journey.querySelectorAll('.fn-trek-code')].map((node) => node.textContent), ['PVG', 'KIX']);
  assert.equal(journey.querySelector('.fn-trek-duration').textContent, '2 h 5 min');
  assert.equal(journey.querySelector('.fn-trek-status').textContent, 'Not confirmed');
  assert.doesNotMatch(journey.textContent, /DQYZ8T/);
  // Items on adjacent lines share one box; a blank line keeps the next one apart.
  const groups = reader.querySelectorAll('.fn-trek-group');
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].children].map((card) => card.dataset.kind), ['place', 'day']);
  assert.equal(journey.closest('.fn-trek-group'), null);
  // The trip no longer has day 7: the card keeps the name it was inserted with.
  assert.match(reader.querySelector('.fn-trek--missing').textContent, /Day two.*Removed from this trip/);
  place().querySelector('.fn-trek-map').click();
  assert.ok(app.calls.some((call) => call.external === inari.map));
  place().querySelector('.fn-trek-main').click();
  assert.ok(app.calls.some((call) => call.navigate === '/trips/10?tab=plan&place=501'));
  // In running text an item is a tag with its current name, and opens its card.
  const chip = reader.querySelector('.fn-trek-chip');
  assert.equal(chip.textContent, '⛩️Fushimi Inari');
  chip.click(); await until(() => app.doc.querySelector('.fn-trek-pop .fn-trek[data-kind="place"]'));
  app.doc.querySelector('.fn-trek-pop .fn-trek-main').click();
  await until(() => !app.doc.querySelector('.fn-trek-pop'));

  button(app, 'Edit snapshot').click(); await until(() => app.doc.querySelector('#content-editor .cm-content'));
  await until(() => app.calls.some((call) => call.body?.action === 'objects' && !call.body.refs));
  const editor = app.doc.querySelector('#content-editor .cm-content');
  const view = app.doc.querySelector('#content-editor').liveEditorView;
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  const enter = () => editor.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  // The editor shows the adjacent pair as its one box while the caret is elsewhere, and each line again once it is in them.
  await until(() => editor.querySelectorAll('.fn-md-embed .fn-trek-group > .fn-trek').length === 2);
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } });
  await until(() => !editor.querySelector('.fn-trek-group') && editor.querySelectorAll('.fn-md-embed .fn-trek').length === 2);
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  type('\n'); type('/'); await until(() => app.doc.querySelector('.fn-editor-menu'));
  type('trip');
  await until(() => app.doc.querySelector('.fn-editor-menu .is-active .fn-editor-menu-title')?.textContent === 'Trip item');
  enter(); await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-section')?.textContent === 'From this trip');
  type('kix'); await until(() => app.doc.querySelector('.fn-editor-menu .is-active .fn-editor-menu-title')?.textContent === 'PVG → KIX');
  enter(); await until(() => view.state.doc.toString().endsWith('early.\n![[trek:booking/39|PVG → KIX]]'));
  // `[[` after text offers the trip's items below the notes; one chosen there goes on the next line.
  view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });
  type(' [['); type('inari');
  await until(() => app.doc.querySelector('.fn-editor-menu .fn-editor-menu-title')?.textContent === 'Fushimi Inari');
  enter(); await until(() => view.state.doc.line(2).text === '![[trek:place/501|Fushimi Inari]]');
  assert.equal(view.state.doc.line(1).text, 'Buy an IC card. Keep a spare IC card. ');

  const library = await ui(t, { note: { content: 'Tokyo\n![[trek:place/501|Fushimi Inari]]' } });
  await library.open();
  await until(() => library.doc.querySelector('.fn-markdown .fn-trek--pending .fn-trek-name')?.textContent === 'Fushimi Inari');
  assert.equal(library.calls.some((call) => call.body?.action === 'objects'), false);
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
  await app.open();
  await until(() => app.doc.querySelector('[aria-label="Edit"]'));
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
  await app.open(); await until(() => app.doc.querySelector('.fn-props'));
  assert.equal(app.doc.querySelector('.fn-prop-row dd').textContent, '170');
  assert.equal(app.doc.querySelector('.fn-workspace').textContent.includes('v1'), false);
  app.click('Edit'); await until(() => app.doc.querySelector('.fn-prop-editor'));
  app.click('+ Add property'); await until(() => app.doc.querySelector('.fn-prop-menu'));
  app.click('Select');
  await until(() => app.doc.querySelector('.fn-prop-option-input'));
  assert.equal(app.doc.querySelector('.fn-prop-option-input').placeholder, 'Type an option, then press Enter');
  app.input('.fn-prop-option-input', 'Doing');
  app.doc.querySelector('.fn-prop-option-input').dispatchEvent(new app.window.KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('.fn-prop-option.is-selected'));
  await until(() => app.note().properties.length === 2);
  const [fare, status] = app.note().properties;
  assert.equal(fare.value, 170); assert.equal(status.type, 'select'); assert.equal(status.value, status.options[0].id);
  assert.equal(status.options[0].name, 'Doing');
  // There is no "Done": opening the note again from the note browser leaves the editor, saved.
  app.doc.querySelector('.fn-note-browser .fn-finder-row[aria-current]').click();
  await until(() => app.doc.querySelector('.fn-props .fn-prop-chip')?.textContent === 'Doing');
  await until(() => app.doc.querySelector('.fn-toast[data-show]')?.textContent === 'All changes saved');
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
  // Others appear as named cursors in the text; there is no presence bar, and autosave stays quiet until a save lands.
  assert.equal(app.doc.querySelector('.fn-collab-bar'), null);
  assert.equal(app.doc.querySelector('.fn-toast').hasAttribute('data-show'), false);
  app.remote((doc) => { doc.getText('content').insert(0, 'Buy '); doc.getText('title').insert(10, ' 2026'); });
  await until(() => view.state.doc.toString() === 'Buy Suica');
  await until(() => app.doc.querySelector('#title').value === 'Japan tips 2026');
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' today' } });
  await until(() => synced(app) > 0 && app.note().content === 'Buy Suica today');
  await until(() => app.doc.querySelector('.fn-toast[data-show]')?.textContent === 'All changes saved');
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

test('the preview reads a note the list sends without its text, and shows its icon, dates and text before it is opened', async (t) => {
  const app = await ui(t, { note: { created_at: '2025-03-01T08:00:00Z', updated_at: new Date().toISOString(), icon: '🚃' } });
  const row = app.doc.querySelector('.fn-finder-row[data-kind="note"]');
  assert.equal(row.querySelector('.fn-note-icon').textContent, '🚃');
  row.click(); await until(() => app.doc.querySelector('.fn-preview-meta'));
  assert.match(app.doc.querySelector('.fn-preview-meta').textContent, /^Modified Today \d.* · Created Mar 1, 2025$/);
  assert.equal(app.doc.querySelector('.fn-preview .fn-markdown h1').textContent, 'Bring an IC card');
  assert.equal(app.calls.filter((call) => call.sub.startsWith('/note?')).length, 1);
  row.click(); await until(() => app.doc.querySelector('.fn-layout-reader'));
});

test('an emoji icon chosen while co-editing reaches the note and heads its page', async (t) => {
  const app = await ui(t);
  await openEditor(app);
  app.click('+ Add icon'); await until(() => app.doc.querySelector('.fn-icon-picker-panel'));
  [...app.doc.querySelectorAll('.fn-icon-picker-grid button')].find((button) => button.textContent === '🗾').click();
  await until(() => app.note().icon === '🗾');
  app.doc.querySelector('.fn-note-browser .fn-finder-row[aria-current]').click();
  await until(() => app.doc.querySelector('.fn-note-hero')?.textContent === '🗾');
});

test('a rejected collaboration update stops the session and offers to rejoin', async (t) => {
  const app = await ui(t, { collabError: { code: 403, message: 'Edit permission required.' } });
  await app.open();
  await until(() => app.doc.querySelector('[aria-label="Edit"]'));
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
  const app = await ui(t, { note: { content } }); await app.open();
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
  await app.open(); await until(() => app.doc.querySelector('.fn-markdown a[href^="fieldnotes://note/"]'));
  assert.equal(app.doc.querySelector('.fn-markdown a').textContent, 'Japan tips');
  app.doc.querySelector('.fn-markdown a').click();
  assert.ok(app.calls.some((call) => call.sub.startsWith('/note?')));
});

const KYOTO = '22222222-2222-4222-8222-222222222222';

test('an id link shows the note’s current title, and neither title nor id when the reader cannot open it', async (t) => {
  const gone = '33333333-3333-4333-8333-333333333333';
  const app = await ui(t, {
    note: { content: `Read [[${KYOTO}|Kyoto draft]] and [[${gone}|Secret plan]].` },
    invoke: (sub) => {
      if (sub === `/reference?ref=${KYOTO}`) return { reference: KYOTO, id: KYOTO, title: 'Kyoto in autumn' };
      if (sub.startsWith('/reference')) return { reference: gone, unavailable: true };
    },
  });
  await app.open();
  await until(() => app.doc.querySelector('.fn-markdown a[href="#fieldnotes-unavailable"]'));
  const article = app.doc.querySelector('.fn-markdown');
  assert.equal(article.querySelector('a[href^="fieldnotes://note/"]').textContent, 'Kyoto in autumn');
  const locked = article.querySelector('a[href="#fieldnotes-unavailable"]');
  assert.equal(locked.textContent, '🔒 Note you can’t open');
  assert.equal(locked.getAttribute('title'), 'You don’t have access to this note, or it was deleted.');
  assert.doesNotMatch(article.textContent, /Secret plan/); assert.doesNotMatch(article.textContent, new RegExp(gone));
  const calls = app.calls.length; locked.click();
  assert.equal(app.calls.slice(calls).some((call) => call.sub?.startsWith('/note?')), false);
});

test('linking a note some readers cannot open says who, and its owner can share it with them after confirming', async (t) => {
  const gap = { target: { id: KYOTO, title: 'Kyoto in autumn' }, can_share: true, public: false, hidden_trips: 1,
    people: [{ user: { id: 2, username: 'sherwin' }, grantable: true }, { user: { id: 4, username: 'mei' }, grantable: false }],
    trips: [{ id: 30, title: 'Taiwan' }] };
  const app = await ui(t, { note: { content: 'Tokyo' }, invoke: (sub, init) => {
    if (sub.startsWith('/link-targets')) return { notes: [{ id: KYOTO, title: 'Kyoto in autumn', path: '', restricted: true }] };
    if (sub.startsWith('/link-access')) return { links: sub.includes(KYOTO) ? [gap] : [] };
    if (sub === '/link-grant') return { links: [] };
  } });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(' [['); type('Kyo');
  await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-description')?.textContent
    === 'Some readers can’t open it');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => app.doc.querySelector('.fn-link-gap'));
  const notice = app.doc.querySelector('.fn-link-gap').textContent;
  assert.match(notice, /Not everyone who reads this note can open “Kyoto in autumn”/);
  assert.match(notice, /Readers: sherwin and mei/); assert.match(notice, /Trips: Taiwan/); assert.match(notice, /Other trips: 1/);
  assert.match(notice, /these readers need another way in: mei/);
  app.click('Let them view…');
  await until(() => app.doc.querySelector('[role="dialog"][aria-labelledby="link-grant-title"]'));
  const dialog = app.doc.querySelector('[aria-labelledby="link-grant-title"]');
  assert.deepEqual([...dialog.querySelectorAll('.fn-grant-option')].map((row) => [row.querySelector('input').checked,
    row.children[1].textContent]), [[true, 'sherwin'], [true, 'Taiwan']]);
  dialog.querySelectorAll('.fn-grant-option input')[1].click();
  app.click('Grant access');
  await until(() => app.calls.some((call) => call.sub === '/link-grant'));
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.find((call) => call.sub === '/link-grant').body)),
    { note_id: '11111111-1111-1111-1111-111111111111', target_id: KYOTO, user_ids: [2], trip_ids: [] });
  await until(() => !app.doc.querySelector('.fn-link-gap') && !app.doc.querySelector('[aria-labelledby="link-grant-title"]'));
  assert.equal(app.doc.querySelector('[role="status"]').textContent, 'Shared “Kyoto in autumn”.');
});

test('someone who does not own the linked note is told who can share it, with nothing to press', async (t) => {
  const gap = { target: { id: KYOTO, title: 'Kyoto in autumn' }, can_share: false, public: true, hidden_trips: 0, people: [], trips: [] };
  const app = await ui(t, { note: { content: `See [[${KYOTO}|Kyoto in autumn]]` }, invoke: (sub) => {
    if (sub.startsWith('/link-access')) return { links: [gap] };
    if (sub.startsWith('/reference')) return { reference: KYOTO, id: KYOTO, title: 'Kyoto in autumn' };
  } });
  await openEditor(app);
  await until(() => app.doc.querySelector('.fn-link-gap'));
  const notice = app.doc.querySelector('.fn-link-gap');
  assert.match(notice.textContent, /This note is public; “Kyoto in autumn” is not\./);
  assert.match(notice.textContent, /Only the owner of “Kyoto in autumn” can share it\./);
  assert.equal([...notice.querySelectorAll('button')].some((button) => button.textContent === 'Let them view…'), false);
  notice.querySelector('[aria-label="Close"]').click();
  await until(() => !app.doc.querySelector('.fn-link-gap'));
});

test('typing [[ searches notes and links the chosen one by id, titled at once', async (t) => {
  const app = await ui(t, { note: { content: 'Tokyo' }, invoke: (sub) => sub.startsWith('/link-targets')
    ? { notes: [{ id: KYOTO, title: 'Kyoto [autumn]', icon: '🍁', path: 'Japan' }] } : undefined });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(' see '); type('['); type('[');
  await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-title'));
  type('Kyo');
  await until(() => app.calls.some((call) => call.sub === '/link-targets?q=Kyo&exclude=11111111-1111-1111-1111-111111111111'));
  assert.equal(app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-description').textContent, 'Japan');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-editor-menu'));
  assert.equal(view.state.doc.toString(), `Tokyo see [[${KYOTO}|Kyoto autumn]]`);
  view.dispatch({ selection: { anchor: 0 } });
  await until(() => content.querySelector('.fn-md-wikilink')?.textContent === 'Kyoto [autumn]');
  assert.equal(content.querySelector('.fn-md-wikilink--missing'), null);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(app.calls.some((call) => call.sub.startsWith('/reference')), false);
});

test('with no matching note, Enter closes the link menu and keeps the typed text', async (t) => {
  const app = await ui(t, { note: { content: 'Tokyo' }, invoke: (sub) => sub.startsWith('/link-targets') ? { notes: [] } : undefined });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(' [['); type('Nara');
  await until(() => app.doc.querySelector('.fn-editor-menu-empty')?.textContent === 'No matching notes');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => !app.doc.querySelector('.fn-editor-menu'));
  assert.equal(view.state.doc.toString().startsWith('Tokyo [[Nara'), true);
});

test('a note lists the notes that link to it and opens one from there', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/backlinks')
    ? { notes: [{ id: KYOTO, title: 'Kyoto in autumn', icon: '🍁', snippet: 'Buy an IC card first: Japan tips' }] } : undefined });
  await app.open(); await until(() => app.doc.querySelector('.fn-backlinks'));
  assert.ok(app.calls.some((call) => call.sub === '/backlinks?note_id=11111111-1111-1111-1111-111111111111'));
  assert.equal(app.doc.querySelector('.fn-backlinks-count').textContent, '1');
  assert.equal(app.doc.querySelector('.fn-backlink-snippet').textContent, 'Buy an IC card first: Japan tips');
  app.doc.querySelector('.fn-backlink').click();
  await until(() => app.calls.some((call) => call.sub === `/note?id=${KYOTO}`));
});

test('on a trip page links resolve and open through the trip, among its notes', async (t) => {
  const kyoto = { id: KYOTO, title: 'Kyoto in autumn', content: 'Maples', version: 1, updated_at: '2026-09-21', mode: 'live' };
  const app = await ui(t, { trip: true, note: { content: `Then [[${KYOTO}|Kyoto]].` }, invoke: (sub, init) => {
    const body = init?.body || {};
    if (sub === '/trip' && body.action === 'reference') return { reference: body.ref, id: KYOTO, title: 'Kyoto in autumn' };
    if (sub === '/trip' && body.action === 'comments') return [];
    if (sub === '/trip' && body.action === 'list') return { trip: { id: 10, title: 'Japan trip' },
      notes: [{ ...app_note(), mode: 'live' }, kyoto] };
  } });
  function app_note() { return { id: '11111111-1111-1111-1111-111111111111', title: 'Japan tips', content: `Then [[${KYOTO}|Kyoto]].`,
    version: 1, updated_at: '2026-09-21', owner_id: 1 }; }
  await app.open(); await until(() => app.doc.querySelector('.fn-markdown a[href^="fieldnotes://note/"]'));
  assert.equal(app.calls.some((call) => call.sub.startsWith('/reference')), false);
  app.doc.querySelector('.fn-markdown a').click();
  await until(() => app.doc.querySelector('.fn-detail-header h2')?.textContent === 'Kyoto in autumn');
});

test('client renders a resolved internal image resource without loading its source URL', async (t) => {
  const source = 'fieldnotes://asset/dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const app = await ui(t, {
    note: { content: `![station](${source})` },
    invoke: (sub) => sub.startsWith('/asset') ? { source, data_url: 'data:image/png;base64,cG5n' } : undefined,
  });
  await app.open();
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

const PDF_URL = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`;

test('a PDF reads in its own frame, and pdf.js loads only once a note shows one', async (t) => {
  const source = 'fieldnotes://asset/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const app = await ui(t, { note: { content: `Tickets\n\n![Hotel booking.pdf](${source})` },
    invoke: (sub) => sub.startsWith('/asset') ? { source, data_url: PDF_URL } : undefined });
  assert.equal(app.doc.querySelector('script[src="pdf.js"]'), null);
  await app.open();
  await until(() => app.doc.querySelector('.fn-markdown figure.fn-pdf'));
  assert.equal(app.doc.querySelector('.fn-markdown .fn-pdf-name').textContent, 'Hotel booking.pdf');
  assert.equal(app.doc.querySelector('.fn-markdown img'), null);
  assert.equal(app.doc.querySelectorAll('script[src="pdf.js"]').length, 1);
});

test('a PDF picked from the slash menu uploads as it is and shows in the editor', async (t) => {
  const source = 'fieldnotes://asset/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const app = await ui(t, { note: { content: 'Bookings' }, invoke: (sub) => sub === '/upload' ? { source } : undefined });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  const picker = app.doc.querySelector('.fn-image-picker'); let asked = '';
  picker.click = () => { asked = picker.accept; };
  type('\n'); type('/'); await until(() => app.doc.querySelector('.fn-editor-menu')); type('pdf');
  await until(() => app.doc.querySelector('.fn-editor-menu .is-active .fn-editor-menu-title')?.textContent === 'PDF');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(asked, 'application/pdf');
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  Object.defineProperty(picker, 'files', { value: [new app.window.File([bytes], 'Hotel booking.pdf', { type: 'application/pdf' })] });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await until(() => content.querySelector('figure.fn-md-pdf'));
  assert.equal(app.calls.find((call) => call.sub === '/upload').body.data, bytes.toString('base64'));
  await until(() => app.note().content === `Bookings\n![Hotel booking.pdf](${source})\n`);
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
  assert.deepEqual([...app.doc.querySelectorAll('.fn-editor-menu-section')].map((node) => node.textContent),
    ['Media', 'Links', 'Basic blocks']);
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
  let release; let hang = false;
  const app = await ui(t, { note: { content: 'Station exit' }, invoke: async (sub) => {
    if (sub === '/upload') return { source };
    // Once the editor is open, reopening the note from the note browser hangs, keeping an action running.
    if (sub.startsWith('/note?') && hang) await new Promise((resolve) => { release = resolve; });
  } });
  const { content } = await openEditor(app); hang = true;
  app.doc.querySelector('.fn-mini-finder .fn-finder-row[aria-current="page"]').click();
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
    if (sub.startsWith('/asset')) {
      return { error: 'Image host is not allowed. Paste the image itself, or ask an admin to allow this host.', status: 403 };
    }
  } });
  await app.open();
  await until(() => app.doc.querySelector('.fn-markdown em')?.textContent.includes('this site is not allowed'));
  assert.equal(app.doc.querySelector('.fn-markdown img'), null);
});

test('server conflicts stay visible and preserve the unsaved draft', async (t) => {
  const app = await ui(t, { invoke: (sub) => {
    if (sub === '/save') return { error: 'This note changed. Reload before saving.', status: 409 };
  } });
  await app.newNote();
  app.input('#title', 'Unsaved');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('[role="alert"]'));
  assert.match(app.doc.querySelector('[role="alert"]').textContent, /changed/);
  assert.equal(app.doc.querySelector('#title').value, 'Unsaved');
});

test('server failures are shown in the reader language, with translated parameters', async (t) => {
  const app = await ui(t, { locale: 'de', invoke: (sub) => sub === '/save'
    ? { error: 'Invalid value: title.', status: 400, template: 'Invalid value: {field}.', params: { field: 'title' } } : undefined });
  await app.newNote();
  app.input('#title', 'Entwurf');
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.doc.querySelector('[role="alert"]'));
  assert.equal(app.doc.querySelector('[role="alert"]').textContent, 'Ungültiger Wert: Titel.');
});

test('host locale and theme context changes do not discard an in-progress draft', async (t) => {
  const app = await ui(t); await app.newNote();
  app.input('#title', 'Keep my draft'); app.changeContext({ locale: 'zh-CN', theme: 'dark' });
  await until(() => app.doc.documentElement.lang === 'zh-CN');
  assert.equal(app.doc.querySelector('#title').value, 'Keep my draft');
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === '保存笔记'));
});

test('supported TREK locales translate the main editor actions', async (t) => {
  const app = await ui(t, { locale: 'de' }); await app.newNote(); await until(() => app.doc.querySelector('#content-editor'));
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === 'Notiz speichern'));
  app.changeContext({ locale: 'zh-TW' }); await until(() => app.doc.documentElement.lang === 'zh-TW');
  assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === '儲存筆記'));
  // TREK sends BCP-47 tags; Greek arrives as el-GR although TREK's own code for it is 'gr'.
  for (const [locale, save] of [['ja-JP', 'ノートを保存'], ['el-GR', 'Αποθήκευση σημείωσης']]) {
    app.changeContext({ locale }); await until(() => app.doc.documentElement.lang === locale);
    assert.ok([...app.doc.querySelectorAll('button')].some((button) => button.textContent === save), locale);
  }
});

test('the note page keeps the way back above the note, sharing beside edit, and visibility inside the sharing window', async (t) => {
  const app = await ui(t, { invoke: (sub, init) => sub === '/note-settings'
    ? { ...app.note(), visibility: init.body.visibility } : undefined });
  await app.open();
  assert.ok(app.doc.querySelector('.fn-reader-column > .fn-reader-back'));
  assert.equal(app.doc.querySelector('.fn-reader-bar .fn-reader-back, .fn-note-browser h2'), null);
  const actions = [...app.doc.querySelectorAll('.fn-note-actions button')].map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(actions, ['Edit', 'Sharing', 'Version history', 'Delete note']);
  app.doc.querySelector('.fn-note-actions .fn-reader-share').click();
  await until(() => app.doc.querySelector('.fn-share-modal #visibility'));
  app.select('.fn-share-modal #visibility', 'public');
  await until(() => app.calls.some((call) => call.sub === '/note-settings' && call.body?.visibility === 'public'));
});

test('the editor writes on the page: properties fold away and live counts float at the bottom', async (t) => {
  const app = await ui(t, { note: { content: 'Suica 几乎 [[11111111-1111-1111-1111-111111111111|Kyoto]]',
    properties: [{ id: 'fare', name: 'Fare', type: 'number', value: 170 }] } });
  const { view } = await openEditor(app);
  assert.equal([...app.doc.querySelectorAll('.trek-label')].some((label) => /^(Title|Markdown|Properties)$/.test(label.textContent)),
    false);
  const stats = () => app.doc.querySelector('.fn-writing-stats').textContent;
  assert.match(stats(), /^Words: 4Characters: 14$/);
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' 末班车' } });
  await until(() => /Words: 7/.test(stats()));
  const fold = app.doc.querySelector('.fn-prop-section-heading button');
  fold.click(); await until(() => app.doc.querySelector('#note-properties').hasAttribute('inert'));
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(app.window.localStorage.getItem('fieldnotes:properties-collapsed'), '1');
  fold.click(); await until(() => !app.doc.querySelector('#note-properties').hasAttribute('inert'));
});

test('a link can reach a heading, here or in another note, and an embed shows that note’s section in place', async (t) => {
  const kyoto = { id: KYOTO, title: 'Kyoto in autumn',
    content: '# Kyoto\n## Getting there\nTake the JR.\n## Food\nYudofu near *Nanzen-ji*.',
    version: 1, updated_at: '2026-09-21', owner_id: 1, can_edit: true };
  const app = await ui(t, {
    note: { content: `# Bring an IC card\nSee [[${KYOTO}#Getting there|Kyoto › Getting there]] and [[#Bring an IC card]].\n\n`
      + `![[${KYOTO}#Food|Kyoto › Food]]\n\nAfter.` },
    invoke: (sub) => {
      if (sub === `/reference?ref=${KYOTO}&embed=1`) return { reference: KYOTO, id: KYOTO, title: kyoto.title, content: kyoto.content };
      if (sub === `/note?id=${KYOTO}`) return kyoto;
    },
  });
  await app.open(); await until(() => app.doc.querySelector('.fn-embed .fn-embed-body'));
  const article = app.doc.querySelector('.fn-markdown');
  const embed = article.querySelector('.fn-embed');
  assert.equal(embed.querySelector('.fn-embed-title').textContent, 'Kyoto in autumn');
  assert.equal(embed.querySelector('.fn-embed-body').textContent.replace(/\s+/g, ' ').trim(), 'Food Yudofu near Nanzen-ji.');
  assert.equal(embed.querySelector('em').textContent, 'Nanzen-ji');
  assert.equal(article.lastElementChild.textContent, 'After.');
  const [toKyoto, here] = article.querySelectorAll(':scope > p a');
  assert.equal(toKyoto.textContent, 'Kyoto in autumn › Getting there');
  assert.equal(here.textContent, 'Bring an IC card');
  here.click(); assert.ok(article.querySelector('h1').classList.contains('fn-heading-reached'));
  toKyoto.click();
  await until(() => app.doc.querySelector('.fn-markdown h2.fn-heading-reached')?.textContent === 'Getting there');
});

test('after # the link menu offers headings, and the chosen one is linked by note id and heading', async (t) => {
  const app = await ui(t, { note: { content: '# Plan\n## Trains\nTokyo' }, invoke: (sub) => sub.startsWith('/link-targets')
    ? { notes: [{ id: KYOTO, title: 'Kyoto', headings: ['Kyoto', 'Getting there', 'Food'] }] } : undefined });
  const { content, view } = await openEditor(app);
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(' [['); await until(() => app.doc.querySelector('.fn-editor-menu--link'));
  type('Kyo#get');
  await until(() => app.calls.some((call) => call.sub === '/link-targets?q=Kyo&exclude=11111111-1111-1111-1111-111111111111&headings=1'));
  await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-title')?.textContent === 'Getting there');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-editor-menu'));
  assert.equal(view.state.doc.toString(), `# Plan\n## Trains\nTokyo [[${KYOTO}#Getting there|Kyoto › Getting there]]`);
  type(' [['); await until(() => app.doc.querySelector('.fn-editor-menu--link'));
  type('#tr');
  await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-title')?.textContent === 'Trains');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => view.state.doc.toString().endsWith(' [[#Trains]]'));
});

test('typed title links become id links in one undoable edit, offered only when there are some', async (t) => {
  const app = await ui(t, { note: { content: 'See [[Kyoto#Food]] and [[Kyoto|the city]].' },
    invoke: (sub) => sub.startsWith('/reference') ? { reference: 'Kyoto', id: KYOTO, title: 'Kyoto' } : undefined });
  const { content, view } = await openEditor(app);
  await until(() => content.querySelector('.fn-md-wikilink'));
  content.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const item = () => [...app.doc.querySelectorAll('.fn-editor-menu button')]
    .find((button) => button.getAttribute('aria-label') === 'Keep 2 typed links working after renames'
      || button.textContent === 'Keep 2 typed links working after renames');
  await until(item); item().click();
  assert.equal(view.state.doc.toString(), `See [[${KYOTO}#Food|Kyoto › Food]] and [[${KYOTO}|the city]].`);
  content.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await until(() => app.doc.querySelector('.fn-editor-menu'));
  assert.equal([...app.doc.querySelectorAll('.fn-editor-menu-section')].some((section) => section.textContent === 'Links'), false);
});

test('unlinked mentions stay folded under the backlinks, and linking them lists the note as linked', async (t) => {
  let linked = false;
  const mention = { id: KYOTO, title: 'Kyoto in autumn', icon: null, snippet: 'Buy Japan tips first', can_link: true };
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub.startsWith('/backlinks')) return linked ? { notes: [{ ...mention, can_link: undefined }], mentions: [] }
      : { notes: [], mentions: [mention, { ...mention, id: '44444444-4444-4444-8444-444444444444', title: 'Read only', can_link: false }] };
    if (sub === '/link-mentions') { linked = true; assert.deepEqual({ ...init.body },
      { note_id: KYOTO, target_id: '11111111-1111-1111-1111-111111111111' }); return { linked: 1 }; }
  } });
  await app.open(); await until(() => app.doc.querySelector('.fn-mentions'));
  const toggle = app.doc.querySelector('.fn-mentions button[aria-expanded]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.ok(app.doc.querySelector('#fn-mentions-list').hasAttribute('inert'));
  toggle.click(); await until(() => !app.doc.querySelector('#fn-mentions-list').hasAttribute('inert'));
  assert.equal(app.doc.querySelectorAll('.fn-mention-link').length, 1);
  app.doc.querySelector('.fn-mention-link').click();
  await until(() => !app.doc.querySelector('.fn-mentions')
    && app.doc.querySelector('.fn-backlink-title')?.textContent === 'Kyoto in autumn');
  assert.equal(app.doc.querySelector('[role="status"]').textContent, 'Linked the mentions in “Kyoto in autumn”.');
});

test('the history window reads an earlier version and restores it', async (t) => {
  const listing = { current: { edited_at: new Date().toISOString(), editors: [{ id: 1, name: 'Tangerine' }], title: 'Japan tips',
    length: 18 },
    versions: [{ id: 'v1', edited_at: new Date(Date.now() - 3600000).toISOString(), editors: [{ id: 2, name: 'sherwin' }],
      title: 'Japan notes', length: 12 },
    { id: 'v0', edited_at: '2026-01-02T08:00:00.000Z', editors: [], title: 'Japan tips', length: 4 }] };
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub.startsWith('/history')) return listing;
    if (sub.startsWith('/version')) return { id: 'v1', edited_at: listing.versions[0].edited_at, title: 'Japan notes', icon: null,
      properties: [], content: '## Older\nPaper tickets.' };
    if (sub === '/restore') return { ...app.note(), title: 'Japan notes', content: '## Older\nPaper tickets.', version: 2 };
  } });
  await app.open();
  app.doc.querySelector('.fn-note-actions [aria-label="Version history"]').click();
  await until(() => app.doc.querySelectorAll('.fn-history-entry').length === 3);
  const entries = [...app.doc.querySelectorAll('.fn-history-entry')];
  assert.match(entries[0].textContent, /^Current version/); assert.match(entries[1].textContent, /Japan notes · sherwin/);
  assert.equal(app.doc.querySelector('.fn-history-reader .fn-history-title').textContent, 'Japan tips');
  assert.equal([...app.doc.querySelectorAll('.fn-history-reader button')]
    .some((button) => button.textContent === 'Restore this version'), false);
  entries[1].click();
  await until(() => app.doc.querySelector('.fn-history-reader h2.fn-history-title')?.textContent === 'Japan notes');
  await until(() => app.doc.querySelector('.fn-history-reader .fn-markdown h2')?.textContent === 'Older');
  app.click('Restore this version');
  await until(() => app.calls.some((call) => call.sub === '/restore'));
  assert.deepEqual({ ...app.calls.find((call) => call.sub === '/restore').body },
    { note_id: '11111111-1111-1111-1111-111111111111', version_id: 'v1', version: 1 });
  await until(() => app.doc.querySelector('.fn-detail-header h2')?.textContent === 'Japan notes');
  assert.match(app.doc.querySelector('[role="status"]').textContent, /^Restored the version from /);
});

test('a body past TREK’s 100 KB limit goes ahead in parts and arrives whole', async (t) => {
  const app = await ui(t);
  await app.newNote();
  const long = '长'.repeat(40000);
  app.input('#title', 'Long read'); app.input('#content', long);
  app.doc.querySelector('#title').closest('form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.calls.some((call) => call.sub === '/save'));
  const parts = app.calls.filter((call) => call.sub === '/part');
  assert.ok(parts.length > 1);
  const save = app.calls.find((call) => call.sub === '/save');
  assert.deepEqual(Object.keys(save.body), ['parts_id']);
  assert.ok(parts.every((call, index) => call.body.id === save.body.parts_id && call.body.parts === parts.length
    && call.body.part === index));
  const body = JSON.parse(Buffer.from(parts.map((call) => call.body.data).join(''), 'base64').toString('utf8'));
  assert.equal(body.content, long);
});

test('the editor shows an embedded note in place until the caret reaches its line, and / can start one', async (t) => {
  const app = await ui(t, { note: { content: `Intro\n![[${KYOTO}]]\nOutro` }, invoke: (sub) => {
    if (sub.startsWith('/reference')) return { reference: KYOTO, id: KYOTO, title: 'Kyoto', content: 'Maples in **November**.' };
    if (sub.startsWith('/link-targets')) return { notes: [{ id: KYOTO, title: 'Kyoto' }] };
  } });
  const { content, view, caret } = await openEditor(app);
  await until(() => content.querySelector('.fn-md-embed .fn-embed-body strong')?.textContent === 'November');
  caret('![['); await until(() => !content.querySelector('.fn-md-embed'));
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  type('\n'); type('/'); await until(() => app.doc.querySelector('.fn-editor-menu--slash'));
  type('embed'); await until(() => app.doc.querySelector('.fn-editor-menu .is-active .fn-editor-menu-title')?.textContent === 'Embed note');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-title')?.textContent === 'Kyoto');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => view.state.doc.toString().endsWith(`Outro\n![[${KYOTO}|Kyoto]]`));
});

test('linking a note that is also embedded keeps the embed showing its text', async (t) => {
  const app = await ui(t, { note: { content: `Intro\n![[${KYOTO}]]\nOutro` }, invoke: (sub) => {
    if (sub.startsWith('/reference')) return { reference: KYOTO, id: KYOTO, title: 'Kyoto', content: 'Maples in **November**.' };
    if (sub.startsWith('/link-targets')) return { notes: [{ id: KYOTO, title: 'Kyoto' }] };
  } });
  const { content, view } = await openEditor(app);
  await until(() => content.querySelector('.fn-md-embed strong')?.textContent === 'November');
  const type = (text) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: text },
    selection: { anchor: view.state.selection.main.head + text.length }, userEvent: 'input.type' });
  view.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } });
  type(' [['); await until(() => app.doc.querySelector('.fn-editor-menu--link .fn-editor-menu-title')?.textContent === 'Kyoto');
  content.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => view.state.doc.toString().endsWith(`[[${KYOTO}|Kyoto]]`));
  view.dispatch({ selection: { anchor: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(content.querySelector('.fn-md-embed strong')?.textContent, 'November');
});

test('a callout reads as a tinted box with its kind’s title, and a folding one opens from its title', async (t) => {
  const app = await ui(t, { note: { content: '> [!tip]\n> Buy a Suica.\n\n> [!warning]- Cash only\n> Bring yen for the bus.' } });
  await app.open();
  await until(() => app.doc.querySelector('.fn-markdown blockquote[data-callout="warning"]'));
  const tip = app.doc.querySelector('.fn-markdown blockquote[data-callout="tip"]');
  assert.equal(tip.querySelector('[data-callout-title]').textContent, 'Tip');
  assert.equal(tip.textContent.includes('[!tip]'), false);
  const warning = app.doc.querySelector('blockquote[data-callout="warning"]'); const title = warning.querySelector('[data-callout-title]');
  assert.equal(title.textContent, 'Cash only'); assert.equal(warning.dataset.fold, 'closed');
  assert.equal(title.getAttribute('aria-expanded'), 'false');
  title.click();
  assert.equal(warning.dataset.fold, 'open'); assert.equal(title.getAttribute('aria-expanded'), 'true');
});

test('the outline lists a note’s headings and closes once one is chosen', async (t) => {
  const app = await ui(t, { note: { content: '# Arrival\nLand at Haneda.\n## [Keikyu](https://x.test) line\nTo Shinagawa.' } });
  await app.open();
  await until(() => button(app, 'Outline'));
  button(app, 'Outline').click();
  await until(() => app.doc.querySelector('.fn-outline-popover'));
  const items = [...app.doc.querySelectorAll('.fn-outline-item')];
  assert.deepEqual(items.map((item) => item.textContent), ['Arrival', 'Keikyu line']);
  assert.equal(items[1].dataset.level, '1');
  items[1].click();
  await until(() => !app.doc.querySelector('.fn-outline-popover'));
});

test('⌘O finds a note, > runs a command, and Escape closes the switcher', async (t) => {
  const app = await ui(t, { invoke: (sub) => sub.startsWith('/link-targets')
    ? { notes: [{ id: '22222222-2222-2222-2222-222222222222', title: 'Osaka eats', path: 'Food' }] } : undefined });
  await app.open();
  const press = (key, init = {}) => app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  press('o', { metaKey: true });
  await until(() => app.doc.querySelector('.fn-palette-row'));
  assert.equal(app.doc.querySelector('.fn-palette-label').textContent, 'Osaka eats');
  assert.equal(app.doc.querySelector('.fn-palette-detail').textContent, 'Food');
  const input = app.doc.querySelector('.fn-palette-input');
  input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !app.doc.querySelector('.fn-palette'));
  press('p', { ctrlKey: true });
  await until(() => app.doc.querySelector('.fn-palette-input')?.value === '>');
  const labels = [...app.doc.querySelectorAll('.fn-palette-label')].map((node) => node.textContent);
  assert.ok(labels.includes('Edit') && labels.includes('Version history'), labels.join());
  app.input('.fn-palette-input', '>edit');
  await until(() => app.doc.querySelectorAll('.fn-palette-row').length === 1);
  app.doc.querySelector('.fn-palette-input').dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => app.doc.querySelector('#content-editor .cm-content'));
  assert.equal(app.doc.querySelector('.fn-palette'), null);
});

test('an Obsidian vault imports with its folders, properties, links between notes and files', async () => {
  // The name conflict is the request error the app raises for it, so the importer can tell it from any other failure.
  const { outputFiles: [built] } = await build({ stdin: { contents: "export * from './importer'; export { RequestError } from './api';",
    resolveDir: path.join(__dirname, '../client'), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.text)(module, module.exports, require);
  const { entriesOf, importNotes, RequestError } = module.exports;
  const { zipSync, strToU8 } = require('fflate');
  const zip = zipSync({
    'Vault/Kyoto.md': strToU8('---\ntags: [temple, autumn]\nvisited: 2026-11-24\nsite: https://kyoto.travel\nrating: 5\n'
      + 'aliases:\n  - Miyako\n---\nEat in [[Osaka#Food|Osaka]], see [[Trips/Osaka]].\n![[map.png]]\n![tea](img/tea.jpg)\n![[Osaka]]\n'),
    'Vault/Trips/Osaka.md': strToU8('# Food\nTakoyaki. Back to [[Kyoto]] or [[Nowhere]].'),
    'Vault/attachments/map.png': new Uint8Array([1]), 'Vault/img/tea.jpg': new Uint8Array([2]),
    'Vault/.obsidian/app.json': strToU8('{}'),
  });
  const { name, entries } = await entriesOf([new File([zip], 'Vault.zip')]);
  assert.equal(name, 'Vault');
  assert.deepEqual(entries.map((entry) => entry.path).sort(), ['Kyoto.md', 'Trips/Osaka.md', 'attachments/map.png', 'img/tea.jpg']);
  const folders = []; const notes = []; const writes = new Map(); const uploads = [];
  const result = await importNotes(entries, name, 'parent', {
    folder: async (folderName, parentId) => {
      if (folderName === 'Vault') throw new RequestError('Exists', 409, 'A folder with this name already exists here.');
      folders.push([folderName, parentId]); return `folder-${folders.length}`;
    },
    note: async (fields) => { notes.push(fields); return { id: `00000000-0000-4000-8000-00000000000${notes.length}`, version: 1 }; },
    write: async (note, content) => { writes.set(note.title, content); },
    upload: async (file) => { uploads.push([file.name, file.type]); return `fieldnotes://asset/${file.name}`; },
    progress: () => {},
  });
  assert.deepEqual(result, { notes: 2, skipped: [] });
  assert.deepEqual(folders, [['Vault 2', 'parent'], ['Trips', 'folder-1']]);
  const kyoto = notes.find((note) => note.title === 'Kyoto');
  assert.deepEqual(kyoto.properties.map((property) => [property.name, property.type]),
    [['tags', 'multi_select'], ['visited', 'date'], ['site', 'url'], ['rating', 'number']]);
  assert.deepEqual(kyoto.properties[0].options.map((option) => option.name), ['temple', 'autumn']);
  const osaka = '00000000-0000-4000-8000-000000000002'; const kyotoId = '00000000-0000-4000-8000-000000000001';
  assert.equal(writes.get('Kyoto'), `Eat in [[${osaka}#Food|Osaka]], see [[${osaka}|Osaka]].\n![map.png](fieldnotes://asset/map.png)\n`
    + `![tea](fieldnotes://asset/tea.jpg)\n![[${osaka}|Osaka]]\n`);
  assert.equal(writes.get('Osaka'), `# Food\nTakoyaki. Back to [[${kyotoId}|Kyoto]] or [[Nowhere]].`);
  assert.deepEqual(uploads.sort(), [['map.png', 'image/png'], ['tea.jpg', 'image/jpeg']]);
});

test('an import keeps a file it could not bring as its name and says so', async () => {
  const { outputFiles: [built] } = await build({ entryPoints: [path.join(__dirname, '../client/importer.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node' });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', built.text)(module, module.exports, require);
  const entries = [{ path: 'Trip.md', blob: new Blob(['![[ticket.pdf]] ![[clip.mp4]] ![[gone.png]]']) },
    { path: 'ticket.pdf', blob: new Blob(['%PDF-1.4']) }];
  let written = '';
  const result = await module.exports.importNotes(entries, 'Vault', null, {
    folder: async () => 'folder', note: async () => ({ id: '00000000-0000-4000-8000-000000000001', version: 1 }),
    write: async (_note, content) => { written = content; }, upload: async () => { throw new Error('too-large-pdf'); },
    progress: () => {},
  });
  assert.equal(written, 'ticket.pdf clip.mp4 gone.png');
  assert.deepEqual(result.skipped.sort(), ['Trip.md › clip.mp4', 'Trip.md › gone.png', 'ticket.pdf']);
});

test('a note copies as Markdown that imports back: properties as front matter, id links as titles', async () => {
  const load = async (file) => {
    const { outputFiles: [built] } = await build({ entryPoints: [path.join(__dirname, `../client/${file}`)], bundle: true,
      write: false, format: 'cjs', platform: 'node' });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', built.text)(module, module.exports, require);
    return module.exports;
  };
  const { noteMarkdown } = await load('exporter.ts'); const { frontMatter, propertiesFromFields } = await load('importer.ts');
  const id = '22222222-2222-2222-2222-222222222222';
  const markdown = noteMarkdown({ content: `See [[${id}|Osaka]], [[${id}#Food|Osaka › Food]] and [[${id}|that city]].\n![[${id}|Osaka]]`
    + '\n![[trek:place/501|Fushimi Inari]]',
    properties: [
      { id: 'a', name: 'tags', type: 'multi_select', value: ['o1'],
        options: [{ id: 'o1', name: 'food', color: 0 }, { id: 'o2', name: 'x', color: 1 }] },
      { id: 'b', name: 'visited', type: 'date', value: '2026-11-24' }, { id: 'c', name: 'rating', type: 'number', value: 5 },
      { id: 'd', name: 'note', type: 'text', value: 'true: or not' }, { id: 'e', name: 'edited', type: 'last_edited', value: null },
    ] }, { [id]: 'Osaka' });
  assert.equal(markdown, '---\ntags: [food]\nvisited: "2026-11-24"\nrating: 5\nnote: "true: or not"\n---\n'
    + 'See [[Osaka]], [[Osaka#Food]] and [[Osaka|that city]].\n![[Osaka]]\nFushimi Inari');
  const { fields, body } = frontMatter(markdown);
  assert.deepEqual(propertiesFromFields(fields).map((property) => [property.name, property.type, property.type === 'multi_select'
    ? property.options.map((option) => option.name) : property.value]),
    [['tags', 'multi_select', ['food']], ['visited', 'date', '2026-11-24'], ['rating', 'number', 5], ['note', 'text', 'true: or not']]);
  assert.match(body, /^See \[\[Osaka\]\]/);
});

test('Recently deleted sits at the foot of the library while it holds a note, and recovers it or deletes it permanently', async (t) => {
  const gone = { id: '33333333-3333-4333-8333-333333333333', title: 'Old plan', icon: null, deleted_at: new Date().toISOString(),
    purge_at: new Date(Date.now() + KEPT_MS).toISOString() };
  let bin = [gone];
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub === '/deleted' && init?.method === 'POST') {
      bin = []; return init.body.action === 'recover' ? { ...gone } : { deleted: true };
    }
    if (sub === '/deleted') return bin;
    if (sub.startsWith('/deleted?id=')) return { ...gone, content: '# Kept text', properties: [], updated_at: gone.deleted_at };
  } });
  const binRow = () => app.doc.querySelector('.fn-finder-column[data-column="0"] .fn-finder-bin .fn-finder-row');
  const row = () => app.doc.querySelector('[data-bin] .fn-finder-row');
  assert.equal(app.doc.querySelectorAll('.fn-scope-tab').length, 2);
  await until(() => binRow()); binRow().click(); await until(() => row()?.textContent.includes('Old plan'));
  assert.equal(binRow().getAttribute('aria-current'), 'true');
  assert.equal(app.doc.querySelector('.fn-finder-crumb[aria-current="location"]').textContent, 'Recently deleted');
  assert.match(app.doc.querySelector('.fn-finder-preview .fn-preview-empty').textContent, /30 days/);
  row().click(); await until(() => app.doc.querySelector('.fn-finder-preview .fn-markdown h1')?.textContent === 'Kept text');
  assert.match(app.doc.querySelector('.fn-finder-preview .fn-preview-meta').textContent, /^Deleted Today .*Deleted permanently on /);
  app.click('Recover');
  await until(() => app.calls.some((call) => call.sub === '/deleted' && call.body?.action === 'recover' && call.body.id === gone.id));
  await until(() => app.doc.querySelector('[data-bin] .fn-finder-empty')?.textContent === 'No deleted notes');

  bin = [gone];
  app.doc.querySelector('.fn-finder-toolbar .fn-refresh').click(); await until(() => row());
  assert.deepEqual((await app.menu('Old plan')).map((item) => item.textContent), ['Recover', 'Delete permanently']);
  [...app.doc.querySelectorAll('.fn-context-menu [role="menuitem"]')].at(-1).click();
  await until(() => app.calls.some((call) => call.sub === '/deleted' && call.body?.action === 'delete'));
  assert.match(app.confirmations.at(-1).message, /Delete “Old plan” permanently/);
  await until(() => !row());
  // Once empty and left, it steps out of the library.
  app.doc.querySelector('.fn-finder-crumb').click(); await until(() => !binRow());
});

test('a trip holding a snapshot of the note can only be opened from the library, not removed', async (t) => {
  const app = await ui(t, { invoke: (sub, init) => {
    if (sub === '/trip' && init.body.action === 'links') {
      return [{ id: 10, title: 'Japan trip', mode: 'live' }, { id: 20, title: 'Korea', mode: 'snapshot' }];
    }
  } });
  await app.open();
  app.doc.querySelector('.fn-reader-share').click(); await until(() => app.doc.querySelector('.fn-linked-trip-list'));
  const rows = [...app.doc.querySelectorAll('.fn-linked-trip-list li')];
  assert.equal(rows[0].querySelector('[aria-label="Remove from Japan trip"]') !== null, true);
  assert.equal(rows[1].querySelector('[aria-label="Remove from Korea"]'), null);
  assert.match(rows[1].textContent, /Snapshot/);
  rows[0].querySelector('[aria-label="Remove from Japan trip"]').click();
  await until(() => app.calls.some((call) => call.sub === '/trip' && call.body?.action === 'unlink'));
  assert.equal(JSON.stringify(app.calls.find((call) => call.body?.action === 'unlink').body),
    JSON.stringify({ action: 'unlink', trip_id: 10, note_id: app.note().id, mode: 'live' }));
});

test('a trip keeps what its editors remove in its own Recently deleted, and brings it back', async (t) => {
  const now = new Date().toISOString(); const end = new Date(Date.now() + KEPT_MS).toISOString();
  const copy = { id: '44444444-4444-4444-8444-444444444444', title: 'Kyoto copy', mode: 'snapshot', deleted_at: now, purge_at: end };
  const gone = { id: '55555555-5555-4555-8555-555555555555', title: null, mode: 'live', unavailable: true, deleted_at: now, purge_at: end };
  let bin = [copy, gone];
  const app = await ui(t, { trip: true, invoke: (sub, init) => {
    const action = init?.body?.action;
    if (sub !== '/trip') return undefined;
    if (action === 'deleted' && init.body.note_id) return { ...copy, content: '# Temples', properties: [], updated_at: now };
    if (action === 'deleted') return bin;
    if (action === 'deleted_recover') { bin = [gone]; return { ...copy, mode: 'snapshot' }; }
  } });
  const binRow = () => app.doc.querySelector('.fn-finder-bin .fn-finder-row');
  await until(() => binRow()); binRow().click();
  await until(() => app.doc.querySelectorAll('[data-bin] .fn-finder-row').length === 2);
  assert.deepEqual([...app.doc.querySelectorAll('[data-bin] .fn-finder-row')].map((row) => row.textContent),
    ['Kyoto copy', 'Reference unavailable']);
  assert.match(app.doc.querySelector('.fn-finder-preview .fn-preview-empty').textContent, /removed from this trip/);
  app.doc.querySelector('[data-bin] .fn-finder-row').click();
  await until(() => app.doc.querySelector('.fn-finder-preview .fn-markdown h1')?.textContent === 'Temples');
  assert.match(app.doc.querySelector('.fn-finder-preview .fn-preview-meta').textContent, /^Removed Today /);
  assert.match(app.doc.querySelector('.fn-finder-preview .fn-note-mode').textContent, /Snapshot/);
  app.click('Recover');
  await until(() => app.calls.some((call) => call.body?.action === 'deleted_recover' && call.body.trip_id === 10
    && call.body.note_id === copy.id));
  await until(() => app.doc.querySelectorAll('[data-bin] .fn-finder-row').length === 1);
});
