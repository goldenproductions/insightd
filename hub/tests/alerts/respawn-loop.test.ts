import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { findActiveRespawnLoops, fetchTopArgvs } = require('../../src/alerts/respawn-loop');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE argv_dictionary (
      argv_hash TEXT PRIMARY KEY,
      argv TEXT NOT NULL,
      comm TEXT,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      container_id TEXT,
      pod_uid TEXT,
      pid INTEGER NOT NULL,
      ppid INTEGER,
      argv_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      exited_at TEXT,
      exit_code INTEGER,
      lifetime_ms INTEGER,
      source TEXT NOT NULL,
      UNIQUE(host_id, pid, started_at)
    );
    CREATE INDEX idx_pe_container_started ON process_events(container_id, started_at);
  `);
  return db;
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

let pidCursor = 1000;
function seedSpawns(
  db: Database.Database,
  count: number,
  opts: { containerId: string; argvHash: string; lifetimeMs: number; minutesAgoStart: number },
): void {
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, argv_hash, started_at, exited_at, lifetime_ms, source)
    VALUES ('h1', ?, ?, ?, ?, ?, ?, 'docker')
  `);
  for (let i = 0; i < count; i++) {
    const startedAt = isoMinutesAgo(opts.minutesAgoStart - i * 0.01);
    const exitedAtMs = Date.parse(startedAt.replace(' ', 'T') + 'Z') + opts.lifetimeMs;
    const exitedAt = new Date(exitedAtMs).toISOString().slice(0, 19).replace('T', ' ');
    stmt.run(opts.containerId, pidCursor++, opts.argvHash, startedAt, exitedAt, opts.lifetimeMs);
  }
}

test('findActiveRespawnLoops fires on Jellyfin-shaped pattern', () => {
  const db = freshDb();
  seedSpawns(db, 25, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].containerId, 'c1');
  assert.equal(groups[0].argvHash, 'a1');
  assert.equal(groups[0].spawnCount, 25);
  assert.ok(groups[0].shortRatio >= 0.99);
});

test('no fire below MIN_SPAWNS', () => {
  const db = freshDb();
  seedSpawns(db, 19, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('no fire below short-lifetime ratio', () => {
  const db = freshDb();
  seedSpawns(db, 20, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 30_000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('20 distinct argv hashes (cron diversity) → no fire', () => {
  const db = freshDb();
  for (let i = 0; i < 20; i++) {
    seedSpawns(db, 1, { containerId: 'c1', argvHash: `a${i}`, lifetimeMs: 1000, minutesAgoStart: 14 - i * 0.5 });
  }
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('same argv across 2 containers → 2 distinct groups', () => {
  const db = freshDb();
  seedSpawns(db, 25, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  seedSpawns(db, 25, { containerId: 'c2', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  const ids = groups.map(g => g.containerId).sort();
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('still-running spawns (exited_at NULL) excluded from aggregate', () => {
  const db = freshDb();
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, argv_hash, started_at, source)
    VALUES ('h1', 'c1', ?, 'a1', ?, 'docker')
  `);
  for (let i = 0; i < 25; i++) stmt.run(1000 + i, isoMinutesAgo(14 - i * 0.01));
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('window boundary: spawn just inside window included; just outside excluded', () => {
  const db = freshDb();
  seedSpawns(db, 20, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 14.5 });
  seedSpawns(db, 5,  { containerId: 'c2', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 60 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].containerId, 'c1');
});

test('fetchTopArgvs returns DESC by spawn_count with comm + truncated argv', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen) VALUES (?, ?, ?, datetime('now'))`)
    .run('a1', '/usr/bin/ffmpeg -i /data/movies/' + 'x'.repeat(500), 'ffmpeg');
  db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen) VALUES (?, ?, ?, datetime('now'))`)
    .run('a2', '/bin/sh', 'sh');
  seedSpawns(db, 10, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 5 });
  seedSpawns(db, 3,  { containerId: 'c1', argvHash: 'a2', lifetimeMs: 1000, minutesAgoStart: 5 });
  const argvs = fetchTopArgvs(db, 'c1', new Date(), 15);
  assert.equal(argvs.length, 2);
  assert.equal(argvs[0].argvHash, 'a1');
  assert.equal(argvs[0].comm, 'ffmpeg');
  assert.ok(argvs[0].argv.length <= 200);
  assert.equal(argvs[1].argvHash, 'a2');
});
