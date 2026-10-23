'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { migrateLegacyMetadata } = require('../scripts/migrate-trip-metadata.cjs');

test('legacy migration dry-runs, moves owned snapshots and purges unattributable orphans', () => {
  const hostDb = new DatabaseSync(':memory:');
  const fieldnotesDb = new DatabaseSync(':memory:');
  try {
    hostDb.exec(`CREATE TABLE plugin_entity_metadata (
      id INTEGER PRIMARY KEY, plugin_id TEXT, entity_type TEXT, entity_id INTEGER, key TEXT, value TEXT, updated_at TEXT
    )`);
    fieldnotesDb.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL);
      CREATE TABLE snapshot_assets (trip_id INTEGER, note_id TEXT, source TEXT, mimetype TEXT, size INTEGER, content_base64 TEXT,
        PRIMARY KEY (trip_id, note_id, source));
      CREATE TABLE trip_note_folders (trip_id INTEGER, note_id TEXT, folder_id TEXT, PRIMARY KEY (trip_id, note_id));
      INSERT INTO notes (id, owner_id) VALUES ('11111111-1111-1111-1111-111111111111', 7),
        ('22222222-2222-2222-2222-222222222222', 9);
      INSERT INTO snapshot_assets VALUES (10, '11111111-1111-1111-1111-111111111111', 'fieldnotes://file', 'image/png', 3, 'cG5n');
      INSERT INTO snapshot_assets VALUES (30, '33333333-3333-3333-3333-333333333333', 'fieldnotes://orphan', 'image/png', 3, 'cG5n');
      INSERT INTO trip_note_folders VALUES (10, '11111111-1111-1111-1111-111111111111', 'folder-a');
      INSERT INTO trip_note_folders VALUES (30, '33333333-3333-3333-3333-333333333333', 'folder-orphan');`);
    const metadata = hostDb.prepare(`INSERT INTO plugin_entity_metadata
      (plugin_id, entity_type, entity_id, key, value, updated_at) VALUES (?, 'trip', ?, ?, ?, '2026-01-01T00:00:00.000Z')`);
    metadata.run('fieldnotes', 10, 'note:11111111-1111-1111-1111-111111111111', JSON.stringify({
      mode: 'snapshot', day_id: 101, linked_at: '2025-01-01T00:00:00.000Z',
      snapshot: { title: 'Frozen', content: 'Saved content', tags: ['trip'], version: 3, updated_at: '2024-12-01', visibility: 'private' },
    }));
    metadata.run('fieldnotes', 20, 'note:22222222-2222-2222-2222-222222222222', JSON.stringify({ mode: 'live', day_id: null }));
    metadata.run('fieldnotes', 30, 'note:33333333-3333-3333-3333-333333333333', JSON.stringify({
      mode: 'snapshot', snapshot: { title: 'Removed author', content: 'Orphan data', version: 1 },
    }));
    metadata.run('fieldnotes', 10, 'unrelated-key', JSON.stringify({ keep: true }));
    metadata.run('another-plugin', 10, 'note:11111111-1111-1111-1111-111111111111', JSON.stringify({ mode: 'live' }));

    const dryRun = migrateLegacyMetadata(hostDb, fieldnotesDb);
    assert.deepEqual(dryRun, { legacyLinks: 3, migratedLinks: 2, migratedSnapshots: 1, orphanedLinks: 1, actorUnknown: 2,
      removedMetadata: 0 });
    assert.equal(hostDb.prepare('SELECT COUNT(*) AS count FROM plugin_entity_metadata').get().count, 5);
    assert.equal(fieldnotesDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'trip_note_links'").get().count, 0);

    const applied = migrateLegacyMetadata(hostDb, fieldnotesDb, { apply: true });
    assert.equal(applied.removedMetadata, 3);
    assert.equal(fieldnotesDb.prepare('SELECT COUNT(*) AS count FROM trip_note_links').get().count, 2);
    assert.equal(fieldnotesDb.prepare('SELECT COUNT(*) AS count FROM trip_note_snapshots').get().count, 1);
    assert.equal(fieldnotesDb.prepare('SELECT source_owner_id FROM trip_note_links WHERE trip_id = 10').get().source_owner_id, 7);
    assert.equal(fieldnotesDb.prepare('SELECT linked_by FROM trip_note_links WHERE trip_id = 10').get().linked_by, null);
    assert.equal(fieldnotesDb.prepare('SELECT content FROM trip_note_snapshots').get().content, 'Saved content');
    assert.equal(fieldnotesDb.prepare('SELECT COUNT(*) AS count FROM snapshot_assets').get().count, 1);
    assert.equal(fieldnotesDb.prepare('SELECT COUNT(*) AS count FROM trip_note_folders').get().count, 1);
    assert.equal(hostDb.prepare('SELECT COUNT(*) AS count FROM plugin_entity_metadata').get().count, 2);

    assert.equal(migrateLegacyMetadata(hostDb, fieldnotesDb, { apply: true }).legacyLinks, 0);
  } finally {
    hostDb.close();
    fieldnotesDb.close();
  }
});
