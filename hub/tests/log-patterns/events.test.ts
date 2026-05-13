import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { bootstrap } = require('../../src/db/schema');
const { recordMatch, findRecent, findForAlertType } = require('../../src/log-patterns/events');
const { loadRegistry } = require('../../src/log-patterns/loader');
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  bootstrap(db);
  return db;
}

function makeRegistry(): any {
  const dir = mkdtempSync(path.join(tmpdir(), 'lpat-evt-'));
  writeFileSync(path.join(dir, 'jellyfin.yaml'),
    `images: ["*jellyfin*"]\ntitle: jelly\npatterns:\n` +
    `  - { id: media_file_corrupted, regex: 'File ended prematurely', severity: warning, explains_alert: [respawn_loop] }\n` +
    `  - { id: ffmpeg_fatal, regex: 'fatal', severity: warning }\n`);
  const reg = loadRegistry(dir);
  rmSync(dir, { recursive: true });
  return reg;
}

function evt(patternId: string, line: string) {
  return {
    patternId, hostId: 'h1', containerName: 'jellyfin', image: 'linuxserver/jellyfin',
    matchedLine: line, contextBefore: ['x'], contextAfter: ['y'],
    captures: {}, lineHash: `${patternId}-${line.slice(0, 8)}`,
  };
}

test('recordMatch inserts a new row on first match', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  const row = db.prepare("SELECT pattern_id, occurrences FROM log_pattern_events").get() as any;
  assert.equal(row.pattern_id, 'media_file_corrupted');
  assert.equal(row.occurrences, 1);
});

test('recordMatch upserts on repeat: occurrences bumps, no new row', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  recordMatch(db, evt('media_file_corrupted', 'File ended prematurely'), reg);
  const rows = db.prepare("SELECT occurrences FROM log_pattern_events").all() as Array<{ occurrences: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrences, 3);
});

test('recordMatch with different line_hash creates a sibling row', () => {
  const db = freshDb();
  const reg = makeRegistry();
  const a = evt('media_file_corrupted', 'File ended prematurely');
  const b = { ...evt('media_file_corrupted', 'Premature end of file'), lineHash: 'differentHash' };
  recordMatch(db, a, reg);
  recordMatch(db, b, reg);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM log_pattern_events").get() as any).n;
  assert.equal(count, 2);
});

test('findRecent returns events within window', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'A'), reg);
  // Backdate one row to outside the window
  db.prepare("UPDATE log_pattern_events SET fired_at = datetime('now', '-2 hours')").run();
  recordMatch(db, { ...evt('media_file_corrupted', 'B'), lineHash: 'h2' }, reg);
  const recent = findRecent(db, 'h1', 'jellyfin', '-30 minutes');
  assert.equal(recent.length, 1);
});

test('findForAlertType returns only events whose pattern explains the alert', () => {
  const db = freshDb();
  const reg = makeRegistry();
  recordMatch(db, evt('media_file_corrupted', 'A'), reg);     // explains respawn_loop
  recordMatch(db, evt('ffmpeg_fatal', 'B'), reg);              // explains nothing
  const hits = findForAlertType(db, 'respawn_loop', 'h1', 'jellyfin', '-1 hour', reg);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern_id, 'media_file_corrupted');
});
