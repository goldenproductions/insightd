import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const Database = require('better-sqlite3');
const { bootstrap, pruneOldData, SCHEMA_VERSION } = require('../../src/db/schema');
const { suppressConsole } = require('../helpers/mocks');

describe('schema', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = new Database(':memory:');
  });

  it('bootstrap creates all tables', () => {
    bootstrap(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = tables.map((t: any) => t.name);
    assert.ok(names.includes('container_snapshots'));
    assert.ok(names.includes('disk_snapshots'));
    assert.ok(names.includes('update_checks'));
    assert.ok(names.includes('meta'));
    restore();
  });

  it('bootstrap sets schema version', () => {
    bootstrap(db);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    assert.equal(row.value, String(SCHEMA_VERSION));
    restore();
  });

  it('bootstrap is idempotent', () => {
    bootstrap(db);
    assert.doesNotThrow(() => bootstrap(db));
    restore();
  });

  it('creates indexes', () => {
    bootstrap(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
    const names = indexes.map((i: any) => i.name);
    assert.ok(names.includes('idx_snapshots_host_name_time'));
    assert.ok(names.includes('idx_disk_host_time'));
    assert.ok(names.includes('idx_updates_host_name_time'));
    restore();
  });

  it('bootstrap creates v30 size columns on container_snapshots', () => {
    bootstrap(db);
    const cols = db.prepare("PRAGMA table_info(container_snapshots)").all();
    const names = cols.map((c: any) => c.name);
    assert.ok(names.includes('size_rootfs_bytes'));
    assert.ok(names.includes('size_rw_bytes'));
    restore();
  });

  it('bootstrap creates v31 volume_snapshots table', () => {
    bootstrap(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='volume_snapshots'").get();
    assert.ok(row, 'volume_snapshots should exist');
    const cols = db.prepare('PRAGMA table_info(volume_snapshots)').all();
    const names = cols.map((c: any) => c.name);
    for (const col of ['host_id', 'volume_name', 'driver', 'mountpoint', 'size_bytes', 'ref_count', 'created_at', 'labels', 'collected_at']) {
      assert.ok(names.includes(col), `volume_snapshots missing column ${col}`);
    }
    restore();
  });

  it('v29 → v30 migration adds the size columns without dropping existing data', () => {
    // Start with a v29-shaped table (no size columns).
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE container_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL DEFAULT 'local',
        container_name TEXT NOT NULL, container_id TEXT NOT NULL, status TEXT NOT NULL,
        cpu_percent REAL, memory_mb REAL, restart_count INTEGER DEFAULT 0,
        labels TEXT, exit_code INTEGER,
        collected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '29');
      INSERT INTO container_snapshots (container_name, container_id, status) VALUES ('nginx', 'abc', 'running');
    `);

    bootstrap(db);

    const cols = db.prepare("PRAGMA table_info(container_snapshots)").all();
    const names = cols.map((c: any) => c.name);
    assert.ok(names.includes('size_rootfs_bytes'));
    assert.ok(names.includes('size_rw_bytes'));

    const rows = db.prepare('SELECT container_name, size_rw_bytes FROM container_snapshots').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].container_name, 'nginx');
    assert.equal(rows[0].size_rw_bytes, null);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(version.value, String(SCHEMA_VERSION));
    restore();
  });

  describe('pruneOldData', () => {
    it('deletes rows older than 30 days', () => {
      bootstrap(db);
      const old = '2020-01-01 00:00:00';
      const recent = new Date().toISOString().slice(0, 19).replace('T', ' ');

      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('old', 'abc', 'running', old);
      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('recent', 'def', 'running', recent);

      pruneOldData(db);

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].container_name, 'recent');
      restore();
    });

    it('preserves recent data', () => {
      bootstrap(db);
      const recent = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`INSERT INTO container_snapshots (container_name, container_id, status, collected_at) VALUES (?, ?, ?, ?)`).run('test', 'abc', 'running', recent);

      pruneOldData(db);

      const rows = db.prepare('SELECT * FROM container_snapshots').all();
      assert.equal(rows.length, 1);
      restore();
    });
  });
});
