import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

function getColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
}

describe('schema v51 — proxmox guest-host correlation', () => {
  it('fresh bootstrap creates proxmox columns and index on hosts', () => {
    const db = new Database(':memory:');
    bootstrap(db);

    const hostsCols = getColumns(db, 'hosts');
    assert.ok(hostsCols.includes('proxmox_cluster_id'), 'hosts has proxmox_cluster_id');
    assert.ok(hostsCols.includes('proxmox_node'), 'hosts has proxmox_node');
    assert.ok(hostsCols.includes('proxmox_vmid'), 'hosts has proxmox_vmid');
    assert.ok(hostsCols.includes('proxmox_guest_type'), 'hosts has proxmox_guest_type');

    const csCols = getColumns(db, 'container_snapshots');
    assert.ok(csCols.includes('guest_uuid'), 'container_snapshots has guest_uuid');
    assert.ok(csCols.includes('guest_primary_mac'), 'container_snapshots has guest_primary_mac');

    const indexes = db.prepare("PRAGMA index_list(hosts)").all() as Array<{ name: string }>;
    assert.ok(indexes.some(i => i.name === 'hosts_proxmox_link'), 'hosts has hosts_proxmox_link index');

    const version = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(version, 10), SCHEMA_VERSION);
    db.close();
  });

  it('migrating from v50 adds proxmox columns and index', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    // Simulate a v50 install by dropping the new columns
    db.exec(`
      CREATE TABLE hosts_tmp AS
        SELECT host_id, first_seen, last_seen, agent_version, runtime_type,
               host_group, host_group_override, host_labels
          FROM hosts
    `);
    db.exec('DROP TABLE hosts');
    db.exec(`CREATE TABLE hosts (
      host_id       TEXT PRIMARY KEY,
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
      agent_version TEXT,
      runtime_type  TEXT NOT NULL DEFAULT 'docker',
      host_group    TEXT,
      host_group_override TEXT,
      host_labels   TEXT
    )`);
    db.exec(`INSERT INTO hosts SELECT * FROM hosts_tmp`);
    db.exec('DROP TABLE hosts_tmp');

    db.exec(`
      CREATE TABLE container_snapshots_tmp AS
        SELECT id, host_id, container_name, container_id, status, cpu_percent,
               memory_mb, restart_count, network_rx_bytes, network_tx_bytes,
               blkio_read_bytes, blkio_write_bytes, health_status,
               health_check_output, labels, exit_code, size_rootfs_bytes,
               size_rw_bytes, cpu_limit_cores, cpu_limit_percent,
               memory_limit_mb, cpu_request_cores, memory_request_mb,
               last_oom_killed_at, workload_kind, pod_ip, host_ip,
               pod_conditions, guest_type, guest_vmid, guest_uptime_seconds,
               collected_at
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
      cpu_request_cores REAL,
      memory_request_mb REAL,
      last_oom_killed_at TEXT,
      workload_kind   TEXT,
      pod_ip          TEXT,
      host_ip         TEXT,
      pod_conditions  TEXT,
      guest_type      TEXT,
      guest_vmid      INTEGER,
      guest_uptime_seconds INTEGER,
      collected_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO container_snapshots SELECT * FROM container_snapshots_tmp`);
    db.exec('DROP TABLE container_snapshots_tmp');

    db.prepare("UPDATE meta SET value = '50' WHERE key = 'schema_version'").run();
    bootstrap(db);

    const hostsCols = getColumns(db, 'hosts');
    assert.ok(hostsCols.includes('proxmox_cluster_id'), 'v50→v51 migration adds proxmox_cluster_id');
    assert.ok(hostsCols.includes('proxmox_vmid'), 'v50→v51 migration adds proxmox_vmid');

    const csCols = getColumns(db, 'container_snapshots');
    assert.ok(csCols.includes('guest_uuid'), 'v50→v51 migration adds guest_uuid');
    assert.ok(csCols.includes('guest_primary_mac'), 'v50→v51 migration adds guest_primary_mac');

    const indexes = db.prepare("PRAGMA index_list(hosts)").all() as Array<{ name: string }>;
    assert.ok(indexes.some(i => i.name === 'hosts_proxmox_link'), 'v50→v51 migration creates hosts_proxmox_link index');

    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(parseInt(version, 10), SCHEMA_VERSION);
    db.close();
  });
});
