'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const noteKey = /^note:([0-9a-f-]{36})$/i;

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function snapshotRow(tripId, noteId, reference, linkedAt) {
  const snapshot = reference.snapshot;
  if (!snapshot || typeof snapshot.title !== 'string' || typeof snapshot.content !== 'string') {
    throw new Error(`Invalid legacy snapshot for trip ${tripId}, note ${noteId}.`);
  }
  const tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
  const version = Number(snapshot.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid snapshot version for note ${noteId}.`);
  return {
    tripId, noteId, title: snapshot.title, content: snapshot.content, tags: JSON.stringify(tags), version,
    updatedAt: typeof snapshot.updated_at === 'string' ? snapshot.updated_at : linkedAt,
    visibility: snapshot.visibility === 'public' ? 'public' : 'private', capturedAt: linkedAt,
  };
}

function ensureTripNoteSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trip_note_links (
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
}

function migrateLegacyMetadata(hostDb, fieldnotesDb, { apply = false } = {}) {
  if (apply) ensureTripNoteSchema(fieldnotesDb);
  const rows = hostDb.prepare(`SELECT id, entity_id, key, value, updated_at FROM plugin_entity_metadata
    WHERE plugin_id = 'fieldnotes' AND entity_type = 'trip'`).all().filter((row) => noteKey.test(row.key));
  const valid = []; const orphaned = [];
  for (const row of rows) {
    const noteId = row.key.match(noteKey)[1];
    let reference;
    try { reference = JSON.parse(row.value); }
    catch { throw new Error(`Invalid legacy metadata JSON for trip ${row.entity_id}, note ${noteId}.`); }
    if (!reference || !['live', 'snapshot'].includes(reference.mode)) {
      throw new Error(`Invalid legacy link mode for trip ${row.entity_id}, note ${noteId}.`);
    }
    const tripId = Number(row.entity_id);
    if (!Number.isSafeInteger(tripId) || tripId < 1) throw new Error(`Invalid legacy trip id: ${row.entity_id}.`);
    const linkedAt = typeof reference.linked_at === 'string' ? reference.linked_at : row.updated_at;
    const note = fieldnotesDb.prepare('SELECT owner_id FROM notes WHERE id = ?').get(noteId);
    if (!note) { orphaned.push({ row, tripId, noteId }); continue; }
    const ownerId = Number(note.owner_id);
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error(`Invalid owner for legacy note ${noteId}.`);
    const dayId = Number.isSafeInteger(reference.day_id) && reference.day_id > 0 ? reference.day_id : null;
    valid.push({
      row, tripId, noteId, ownerId, mode: reference.mode, dayId, linkedAt,
      snapshot: reference.mode === 'snapshot' ? snapshotRow(tripId, noteId, reference, linkedAt) : null,
    });
  }

  if (apply) {
    transaction(fieldnotesDb, () => {
      const insertLink = fieldnotesDb.prepare(`INSERT OR IGNORE INTO trip_note_links
        (trip_id, note_id, source_owner_id, linked_by, mode, day_id, linked_at, legacy_actor_unknown)
        VALUES (?, ?, ?, NULL, ?, ?, ?, 1)`);
      const insertSnapshot = fieldnotesDb.prepare(`INSERT OR IGNORE INTO trip_note_snapshots
        (trip_id, note_id, title, content, tags, version, updated_at, visibility, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of valid) {
        insertLink.run(item.tripId, item.noteId, item.ownerId, item.mode, item.dayId, item.linkedAt);
        if (item.snapshot) {
          const snapshot = item.snapshot;
          insertSnapshot.run(snapshot.tripId, snapshot.noteId, snapshot.title, snapshot.content, snapshot.tags,
            snapshot.version, snapshot.updatedAt, snapshot.visibility, snapshot.capturedAt);
        }
      }
      const deleteOrphan = (table) => fieldnotesDb.prepare(`DELETE FROM ${table} WHERE trip_id = ? AND note_id = ?`);
      const deleteAssignment = deleteOrphan('trip_note_folders');
      const deleteAssets = deleteOrphan('snapshot_assets');
      const deleteSnapshot = deleteOrphan('trip_note_snapshots');
      const deleteLink = deleteOrphan('trip_note_links');
      for (const item of orphaned) {
        deleteAssignment.run(item.tripId, item.noteId);
        deleteAssets.run(item.tripId, item.noteId);
        deleteSnapshot.run(item.tripId, item.noteId);
        deleteLink.run(item.tripId, item.noteId);
      }
    });

    for (const item of valid) {
      const link = fieldnotesDb.prepare(`SELECT source_owner_id, mode, legacy_actor_unknown FROM trip_note_links
        WHERE trip_id = ? AND note_id = ?`).get(item.tripId, item.noteId);
      if (!link || link.source_owner_id !== item.ownerId || link.mode !== item.mode || link.legacy_actor_unknown !== 1) {
        throw new Error(`Legacy link verification failed for trip ${item.tripId}, note ${item.noteId}.`);
      }
      if (item.snapshot) {
        const saved = fieldnotesDb.prepare('SELECT title, content FROM trip_note_snapshots WHERE trip_id = ? AND note_id = ?')
          .get(item.tripId, item.noteId);
        if (!saved || saved.title !== item.snapshot.title || saved.content !== item.snapshot.content) {
          throw new Error(`Legacy snapshot verification failed for trip ${item.tripId}, note ${item.noteId}.`);
        }
      }
    }
    transaction(hostDb, () => {
      const remove = hostDb.prepare(`DELETE FROM plugin_entity_metadata
        WHERE id = ? AND plugin_id = 'fieldnotes' AND entity_type = 'trip'`);
      for (const item of [...valid, ...orphaned]) remove.run(item.row.id);
    });
  }

  return {
    legacyLinks: rows.length,
    migratedLinks: valid.length,
    migratedSnapshots: valid.filter((item) => item.snapshot).length,
    orphanedLinks: orphaned.length,
    actorUnknown: valid.length,
    removedMetadata: apply ? rows.length : 0,
  };
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') result.apply = true;
    else if (argv[index] === '--host-db') result.hostDb = argv[++index];
    else if (argv[index] === '--fieldnotes-db') result.fieldnotesDb = argv[++index];
    else if (argv[index] === '--help') result.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/migrate-trip-metadata.cjs --host-db <trek.db> --fieldnotes-db <plugin.db> [--apply]');
    console.log('Default is dry-run. Stop TREK and take verified backups before using --apply.');
    return;
  }
  if (!args.hostDb || !args.fieldnotesDb) throw new Error('Both --host-db and --fieldnotes-db are required.');
  if (path.resolve(args.hostDb) === path.resolve(args.fieldnotesDb)) throw new Error('Database paths must be different.');
  const hostDb = new DatabaseSync(args.hostDb);
  const fieldnotesDb = new DatabaseSync(args.fieldnotesDb);
  try {
    const summary = migrateLegacyMetadata(hostDb, fieldnotesDb, { apply: args.apply });
    console.log(`${args.apply ? 'Migration applied' : 'Dry run'}: ${JSON.stringify(summary)}`);
  } finally {
    hostDb.close();
    fieldnotesDb.close();
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

module.exports = { migrateLegacyMetadata };
