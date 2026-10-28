// Seeds a fresh dev database with fictional demo notes for the README screenshots: node seed.mjs en|zh <db path>
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEMO } from './demo.mjs';


const lang = process.argv[2];
const dbPath = process.argv[3];
const D = DEMO[lang];
const API = 'http://localhost:4317/api';
const call = async (method, path, body) => {
  const response = await fetch(API + path, { method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok || data?.error) throw new Error(`${path} ${JSON.stringify(body)?.slice(0, 120)} → ${text.slice(0, 300)}`);
  return data;
};
const post = (path, body) => call('POST', path, body);

// Library folders first, parents before children.
const folders = {};
for (const [key, [name, icon, parent]] of Object.entries(D.folders)) {
  folders[key] = (await post('/folder', { action: 'create', name, icon, parent_id: parent ? folders[parent] : null,
    visibility: 'private' })).id;
}
// Notes, in an order that lets a link name a note created before it.
const notes = {};
for (const [key, note] of Object.entries(D.notes)) {
  const content = note.content.replace(/\{(\w+)\}/g, (_, target) => notes[target]);
  notes[key] = (await post('/save', { title: note.title, icon: note.icon, content, properties: note.props || [],
    folder_id: folders[note.folder], visibility: 'private' })).id;
}
for (const key of D.public) await post('/note-settings', { id: notes[key], visibility: 'public' });
for (const [key, roles] of Object.entries(D.collaborators)) {
  await post('/collaborator', { action: 'bulk_roles', note_id: notes[key],
    changes: Object.entries(roles).map(([userId, role]) => ({ user_id: Number(userId), role })) });
}
// Each trip's notes, then its folders and what goes in them.
for (const [key, trip, day, mode] of D.links) await post('/link', { note_id: notes[key], trip_id: trip, day_id: day, mode });
for (const [name, icon, members] of D.tripFolders) {
  const made = await post('/trip', { action: 'folder_create', trip_id: 10, name, icon, parent_id: null });
  const folderId = (Array.isArray(made) ? made.find((item) => item.name === name) : made).id;
  for (const key of members) await post('/trip', { action: 'folder_move_note', trip_id: 10, note_id: notes[key], folder_id: folderId });
}
for (const key of D.deleted) {
  const note = await call('GET', `/note?id=${notes[key]}`);
  await post('/archive', { id: note.id, version: note.version });
}

// Others' comments go straight into the table: the dev API always acts as user 1.
const db = new DatabaseSync(dbPath);
const threads = [];
D.comments.forEach(([note, author, body, quote, suffix, parent, resolved], index) => {
  const id = randomUUID(); threads.push(id);
  const at = new Date(Date.now() - (300 - index * 17) * 60000).toISOString();
  db.prepare(`INSERT INTO trip_note_comments (id, trip_id, note_id, parent_id, author_id, body, quote, prefix, suffix, created_at,
    updated_at, resolved_at, resolved_by) VALUES (?, 10, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`)
    .run(id, notes[note], parent === undefined || parent === null ? null : threads[parent], author, body, quote ?? null,
      suffix ?? '', at, at, resolved ? at : null, resolved ? 1 : null);
});
console.log(JSON.stringify(notes));
