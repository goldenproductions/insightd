import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Bootstrap the real schema so generateInsights() can run all of its
// host/container/PVE/disk/predictive queries without "no such table" errors.
// The log-pattern materialization block sits near the END of generateInsights,
// so any earlier query that crashes would prevent it from running.
const { bootstrap } = require('../../src/db/schema');
const { generateInsights } = require('../../src/insights/detector');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id) VALUES ('h1')`).run();
  // containers table has no container_id column — keyed by (host_id, container_name).
  db.prepare(`INSERT INTO containers (host_id, container_name) VALUES ('h1','jellyfin')`).run();
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_id, container_name, status, collected_at, cpu_percent, memory_mb)
    VALUES ('h1','c1','jellyfin','running', datetime('now'), 50, 800)
  `).run();
  return db;
}

test('log_pattern_match insight is materialized for recent event', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO log_pattern_events
      (host_id, container_name, image, pattern_id, matched_line, context_before, context_after, captures, line_hash, occurrences)
    VALUES ('h1','jellyfin','linuxserver/jellyfin','media_file_corrupted','File ended prematurely','["a"]','["b"]','{}','h1', 3)
  `).run();

  generateInsights(db);

  const row = db.prepare(
    "SELECT entity_id, category, metric, evidence FROM insights WHERE metric = 'log_pattern_match'"
  ).get() as { entity_id: string; category: string; metric: string; evidence: string } | undefined;
  assert.ok(row);
  assert.equal(row!.entity_id, 'h1/jellyfin');
  assert.equal(row!.category, 'logs');
  const ev = JSON.parse(row!.evidence);
  assert.equal(ev.pattern_id, 'media_file_corrupted');
  assert.equal(ev.occurrences, 3);
  assert.equal(ev.matched_line, 'File ended prematurely');
  assert.deepEqual(ev.context_before, ['a']);
});

test('events older than 24h are NOT materialized', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO log_pattern_events
      (host_id, container_name, image, pattern_id, matched_line, line_hash, fired_at)
    VALUES ('h1','jellyfin','linuxserver/jellyfin','old_pattern','line','h1', datetime('now','-2 days'))
  `).run();
  generateInsights(db);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM insights WHERE metric = 'log_pattern_match'").get() as any).n;
  assert.equal(count, 0);
});
