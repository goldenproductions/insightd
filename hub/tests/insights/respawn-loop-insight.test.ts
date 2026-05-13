import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Bootstrap the real schema so generateInsights() can run all of its
// host/container/PVE/disk/predictive queries without "no such table" errors.
// The respawn-loop materialization block sits at the END of generateInsights,
// so any earlier query that crashes would prevent it from running.
const { bootstrap } = require('../../../src/db/schema');
const { generateInsights } = require('../../src/insights/detector');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('h1', datetime('now'), datetime('now'))").run();
  // Snapshot tells the detector which container_id corresponds to which name.
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_id, container_name, status, collected_at)
    VALUES ('h1', 'c1', 'jellyfin', 'running', datetime('now'))
  `).run();
  // Registry entry so the main container loop doesn't filter jellyfin out.
  db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES ('h1', 'jellyfin', datetime('now'), datetime('now'), NULL)
  `).run();
  db.prepare(`
    INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen)
    VALUES ('a1', '/usr/bin/ffmpeg -i /data/movie.mkv', 'ffmpeg', datetime('now'))
  `).run();
  return db;
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

test('respawn-loop insight is created when detector fires', () => {
  const db = freshDb();
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, ppid, argv_hash, started_at, exited_at, lifetime_ms, source)
    VALUES ('h1', 'c1', ?, 1, 'a1', ?, ?, 3000, 'docker')
  `);
  for (let i = 0; i < 25; i++) {
    const startedAt = isoMinutesAgo(14 - i * 0.01);
    const exitedAt = new Date(Date.parse(startedAt.replace(' ', 'T') + 'Z') + 3000).toISOString().slice(0, 19).replace('T', ' ');
    stmt.run(1000 + i, startedAt, exitedAt);
  }

  generateInsights(db);

  const rows = db.prepare(
    "SELECT entity_id, category, metric, message, evidence FROM insights WHERE metric = 'process_spawn_count'"
  ).all() as Array<{ entity_id: string; category: string; metric: string; message: string; evidence: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, 'h1/jellyfin');
  assert.equal(rows[0].category, 'availability');
  assert.equal(rows[0].metric, 'process_spawn_count');
  const ev = JSON.parse(rows[0].evidence);
  assert.equal(ev.argv_hash, 'a1');
  assert.equal(ev.spawn_count, 25);
  assert.ok(Array.isArray(ev.top_argvs));
  assert.equal(ev.top_argvs[0].argv_hash, 'a1');
});
