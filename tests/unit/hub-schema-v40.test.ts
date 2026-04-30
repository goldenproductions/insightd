import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v40', () => {
  it('fresh bootstrap has last_oom_killed_at on container_snapshots', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    const cols = getColumns(db, 'container_snapshots');
    assert.ok(cols.includes('last_oom_killed_at'), 'container_snapshots has last_oom_killed_at column');
    db.close();
  });

  it('migrating from v39 adds the column', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    // Simulate a v39 install by rebuilding container_snapshots without the
    // new column, then rewinding schema_version so bootstrap re-runs migrations.
    db.exec(`
      CREATE TABLE _cs_tmp AS
        SELECT id, host_id, container_name, container_id, status, cpu_percent,
               memory_mb, restart_count, network_rx_bytes, network_tx_bytes,
               blkio_read_bytes, blkio_write_bytes, health_status,
               health_check_output, labels, exit_code, size_rootfs_bytes,
               size_rw_bytes, cpu_limit_cores, cpu_limit_percent,
               memory_limit_mb, collected_at
          FROM container_snapshots
    `);
    db.exec('DROP TABLE container_snapshots');
    db.exec(`CREATE TABLE container_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL DEFAULT 'local',
      container_name  TEXT NOT NULL,
      container_id    TEXT NOT NULL,
      status          TEXT NOT NULL,
      cpu_percent     REAL,
      memory_mb       REAL,
      restart_count   INTEGER DEFAULT 0,
      network_rx_bytes INTEGER,
      network_tx_bytes INTEGER,
      blkio_read_bytes INTEGER,
      blkio_write_bytes INTEGER,
      health_status   TEXT,
      health_check_output TEXT,
      labels          TEXT,
      exit_code       INTEGER,
      size_rootfs_bytes INTEGER,
      size_rw_bytes   INTEGER,
      cpu_limit_cores REAL,
      cpu_limit_percent REAL,
      memory_limit_mb REAL,
      collected_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec('DROP TABLE _cs_tmp');
    db.prepare("UPDATE meta SET value = '39' WHERE key = 'schema_version'").run();
    bootstrap(db);
    const cols = getColumns(db, 'container_snapshots');
    assert.ok(cols.includes('last_oom_killed_at'), 'v39→v40 migration adds last_oom_killed_at');
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(v, 10), SCHEMA_VERSION);
    db.close();
  });
});
