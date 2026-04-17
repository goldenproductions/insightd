import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');

const { ingestContainers } = require('../../hub/src/ingest') as {
  ingestContainers: (db: any, hostId: string, containers: any[]) => void;
};

interface ContainerSeed {
  name: string;
  id?: string;
  status?: string;
  restartCount?: number;
}

function batch(names: string[]): ContainerSeed[] {
  return names.map(n => ({ name: n, id: `id-${n}`, status: 'running', restartCount: 0 }));
}

function registryRow(db: any, hostId: string, name: string): { first_seen: string; last_seen: string; removed_at: string | null } | undefined {
  return db.prepare(
    'SELECT first_seen, last_seen, removed_at FROM containers WHERE host_id = ? AND container_name = ?'
  ).get(hostId, name);
}

describe('containers registry', () => {
  let db: any;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates a registry row for every container in the first batch', () => {
    ingestContainers(db, 'h1', batch(['a', 'b', 'c']));

    const rows = db.prepare("SELECT container_name, removed_at FROM containers WHERE host_id = 'h1' ORDER BY container_name").all();
    assert.deepEqual(rows.map((r: any) => r.container_name), ['a', 'b', 'c']);
    for (const r of rows) assert.equal(r.removed_at, null);
  });

  it('marks containers removed when they vanish from the next batch', () => {
    ingestContainers(db, 'h1', batch(['a', 'b', 'c']));
    // Force a noticeable gap so last_seen < new batchAt even with coarse second-granularity clocks
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds') WHERE host_id = 'h1'").run();

    ingestContainers(db, 'h1', batch(['a', 'c']));

    assert.equal(registryRow(db, 'h1', 'a')?.removed_at, null);
    assert.notEqual(registryRow(db, 'h1', 'b')?.removed_at, null);
    assert.equal(registryRow(db, 'h1', 'c')?.removed_at, null);
  });

  it('clears removed_at when a previously-removed container reappears', () => {
    ingestContainers(db, 'h1', batch(['a', 'b']));
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds') WHERE host_id = 'h1'").run();
    ingestContainers(db, 'h1', batch(['a']));
    assert.notEqual(registryRow(db, 'h1', 'b')?.removed_at, null);

    db.prepare("UPDATE containers SET last_seen = datetime('now', '-5 seconds') WHERE host_id = 'h1' AND container_name = 'a'").run();
    ingestContainers(db, 'h1', batch(['a', 'b']));

    assert.equal(registryRow(db, 'h1', 'a')?.removed_at, null);
    assert.equal(registryRow(db, 'h1', 'b')?.removed_at, null);
  });

  it('marks all containers removed when an empty batch arrives', () => {
    ingestContainers(db, 'h1', batch(['a', 'b', 'c']));
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds') WHERE host_id = 'h1'").run();

    ingestContainers(db, 'h1', []);

    for (const name of ['a', 'b', 'c']) {
      assert.notEqual(registryRow(db, 'h1', name)?.removed_at, null, `${name} should be removed`);
    }
  });

  it('only diffs within a single host — other hosts are untouched', () => {
    ingestContainers(db, 'h1', batch(['a', 'b']));
    ingestContainers(db, 'h2', batch(['x', 'y']));
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds')").run();

    ingestContainers(db, 'h1', batch(['a']));

    assert.equal(registryRow(db, 'h1', 'a')?.removed_at, null);
    assert.notEqual(registryRow(db, 'h1', 'b')?.removed_at, null);
    assert.equal(registryRow(db, 'h2', 'x')?.removed_at, null, 'h2 containers must not be affected');
    assert.equal(registryRow(db, 'h2', 'y')?.removed_at, null, 'h2 containers must not be affected');
  });

  it('preserves first_seen across re-sightings', () => {
    ingestContainers(db, 'h1', batch(['a']));
    const firstSeenA = registryRow(db, 'h1', 'a')?.first_seen;
    assert.ok(firstSeenA);

    // Simulate time passing, remove and re-add
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds') WHERE host_id = 'h1'").run();
    ingestContainers(db, 'h1', []);
    assert.notEqual(registryRow(db, 'h1', 'a')?.removed_at, null);

    ingestContainers(db, 'h1', batch(['a']));
    const row = registryRow(db, 'h1', 'a');
    assert.equal(row?.removed_at, null);
    assert.equal(row?.first_seen, firstSeenA, 'first_seen must be preserved across re-add');
  });

  it('ingest is transactional — a failure inside the batch rolls back registry changes', () => {
    ingestContainers(db, 'h1', batch(['a', 'b']));
    db.prepare("UPDATE containers SET last_seen = datetime('now', '-10 seconds') WHERE host_id = 'h1'").run();

    // Force a constraint violation on the snapshot insert by passing an
    // invalid status type (not a string). Any thrown error inside the
    // transaction should roll back both the insert and the markRemoved.
    assert.throws(() => {
      ingestContainers(db, 'h1', [
        { name: 'a', id: 'id-a', status: 'running', restartCount: 0 },
        { name: 'b', id: 'id-b', status: { invalid: true } as unknown as string, restartCount: 0 },
      ]);
    });

    // 'a' should still have its original last_seen (not bumped) and both
    // should still be present (not marked removed), because the whole batch
    // rolled back.
    const a = registryRow(db, 'h1', 'a');
    const b = registryRow(db, 'h1', 'b');
    assert.equal(a?.removed_at, null);
    assert.equal(b?.removed_at, null);
  });
});

describe('containers registry — v27 backfill', () => {
  it('backfills existing container_snapshots on migration from v26', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // Hand-built v26 schema subset — just enough to exercise the backfill.
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE hosts (host_id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, agent_version TEXT, runtime_type TEXT DEFAULT 'docker', host_group TEXT, host_group_override TEXT);
      CREATE TABLE container_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL DEFAULT 'local',
        container_name TEXT NOT NULL,
        container_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cpu_percent REAL, memory_mb REAL, restart_count INTEGER DEFAULT 0,
        network_rx_bytes INTEGER, network_tx_bytes INTEGER,
        blkio_read_bytes INTEGER, blkio_write_bytes INTEGER,
        health_status TEXT, health_check_output TEXT, labels TEXT,
        collected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '26');
    `);

    // One fresh (< 15 min ago), one stale (> 15 min ago).
    db.prepare("INSERT INTO container_snapshots (host_id, container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?, datetime('now', '-2 minutes'))")
      .run('h1', 'fresh', 'id-fresh', 'running');
    db.prepare("INSERT INTO container_snapshots (host_id, container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?, datetime('now', '-2 hours'))")
      .run('h1', 'stale', 'id-stale', 'exited');

    const { bootstrap } = require('../../hub/src/db/schema');
    bootstrap(db);

    const rows = db.prepare("SELECT container_name, removed_at FROM containers WHERE host_id = 'h1' ORDER BY container_name").all();
    assert.equal(rows.length, 2);
    const fresh = rows.find((r: any) => r.container_name === 'fresh');
    const stale = rows.find((r: any) => r.container_name === 'stale');
    assert.equal(fresh.removed_at, null, 'fresh container should be active after backfill');
    assert.notEqual(stale.removed_at, null, 'stale container should be marked removed after backfill');

    db.close();
  });
});
