import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const explainModule = require('../../src/insights/explain');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      category TEXT NOT NULL, severity TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL,
      metric TEXT, current_value REAL, baseline_value REAL,
      evidence TEXT, suggested_action TEXT, confidence TEXT,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE container_snapshots (
      host_id TEXT NOT NULL, container_id TEXT NOT NULL,
      container_name TEXT NOT NULL, restart_count INTEGER DEFAULT 0,
      collected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT, container_id TEXT, pod_uid TEXT,
      pid INTEGER, ppid INTEGER, argv_hash TEXT NOT NULL,
      started_at TEXT NOT NULL, exited_at TEXT, exit_code INTEGER,
      lifetime_ms INTEGER, source TEXT
    );
    CREATE TABLE alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      target TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  db.prepare(`INSERT INTO container_snapshots (host_id, container_id, container_name) VALUES ('h1', 'c1', 'jellyfin')`).run();
  return db;
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

test('respawn-loop explain returns restart_histogram chart + top_argvs extras', () => {
  const db = freshDb();
  // Seed process_events for the argv_hash
  for (let i = 0; i < 10; i++) {
    const startedAt = isoMinutesAgo(60 - i * 5);
    const exitedAt = isoMinutesAgo(60 - i * 5 - 0.01);
    db.prepare(`INSERT INTO process_events (host_id, container_id, pid, argv_hash, started_at, exited_at, lifetime_ms) VALUES ('h1','c1',?,?,?,?,1000)`)
      .run(1000 + i, 'a1', startedAt, exitedAt);
  }

  const evidence = JSON.stringify({
    argv_hash: 'a1',
    spawn_count: 10,
    short_ratio: 0.9,
    avg_lifetime_ms: 1000,
    top_argvs: [{ argv_hash: 'a1', comm: 'ffmpeg', argv: '/usr/bin/ffmpeg -i x.mkv', spawn_count: 10, avg_lifetime_ms: 1000 }],
  });
  const info = db.prepare(`INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value, evidence) VALUES ('container','h1/jellyfin','availability','warning','t','m','process_spawn_count',10,20,?)`).run(evidence);

  const fn = explainModule.buildExplanation;
  assert.ok(fn, 'expected buildExplanation export on explain module');

  // buildExplanation takes (db, insight) — fetch the row first.
  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(Number(info.lastInsertRowid));
  const result = fn(db, insight);
  assert.ok(result.chart);
  assert.equal(result.chart.kind, 'restart_histogram');
  assert.ok(Array.isArray(result.extras));
  assert.equal(result.extras.length, 1);
  assert.equal(result.extras[0].kind, 'top_argvs');
  assert.equal(result.extras[0].rows[0].argv_hash, 'a1');
});
