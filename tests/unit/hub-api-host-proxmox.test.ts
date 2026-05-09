import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database = require('better-sqlite3');
const { bootstrap } = require('../../hub/src/db/schema') as { bootstrap: (db: Database.Database) => void };
const { getHostProxmoxBlock, getHostDetail } = require('../../hub/src/web/queries');

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

function seedHost(db: Database.Database, hostId: string, extras: Record<string, any> = {}) {
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime('now'), datetime('now'))`).run(hostId);
  if (Object.keys(extras).length > 0) {
    const sets = Object.keys(extras).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE hosts SET ${sets} WHERE host_id = ?`).run(...Object.values(extras), hostId);
  }
}

describe('getHostProxmoxBlock', () => {
  let db: Database.Database;

  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it('returns proxmox block when host is linked to PVE guest', () => {
    seedHost(db, 'vm1', {
      proxmox_cluster_id: 'c1',
      proxmox_node: 'pve1',
      proxmox_vmid: 108,
      proxmox_guest_type: 'qemu',
    });

    const result = getHostProxmoxBlock(db, 'vm1');
    assert.deepEqual(result, {
      cluster_id: 'c1',
      node: 'pve1',
      vmid: 108,
      guest_type: 'qemu',
      snapshots_count: 0,
      last_backup_at: null,
    });
  });

  it('returns null when host has no proxmox_vmid', () => {
    seedHost(db, 'bare');
    const result = getHostProxmoxBlock(db, 'bare');
    assert.equal(result, null);
  });

  it('includes snapshot_count from pve_guest_snapshots', () => {
    seedHost(db, 'vm2', { proxmox_cluster_id: 'c1', proxmox_node: 'pve1', proxmox_vmid: 200, proxmox_guest_type: 'lxc' });
    db.prepare(`
      INSERT INTO pve_guest_snapshots (host_id, guest_vmid, snapshot_count, observed_at)
      VALUES ('pve1', 200, 5, datetime('now'))
    `).run();

    const result = getHostProxmoxBlock(db, 'vm2');
    assert.ok(result);
    assert.equal(result.snapshots_count, 5);
  });

  it('includes last_backup_at from pve_guest_backups', () => {
    seedHost(db, 'vm3', { proxmox_cluster_id: 'c1', proxmox_node: 'pve1', proxmox_vmid: 300, proxmox_guest_type: 'qemu' });
    db.prepare(`
      INSERT INTO pve_guest_backups (host_id, guest_vmid, last_backup_at, last_status, observed_at)
      VALUES ('pve1', 300, '2026-05-01T02:00:00Z', 'OK', datetime('now'))
    `).run();

    const result = getHostProxmoxBlock(db, 'vm3');
    assert.ok(result);
    assert.equal(result.last_backup_at, '2026-05-01T02:00:00Z');
  });

  it('getHostDetail response includes proxmox block', () => {
    seedHost(db, 'vm1', { proxmox_cluster_id: 'c1', proxmox_node: 'pve1', proxmox_vmid: 108, proxmox_guest_type: 'qemu' });

    const detail = getHostDetail(db, 'vm1', 10);
    assert.ok(detail, 'detail should not be null');
    assert.deepEqual(detail.proxmox, {
      cluster_id: 'c1',
      node: 'pve1',
      vmid: 108,
      guest_type: 'qemu',
      snapshots_count: 0,
      last_backup_at: null,
    });
  });

  it('getHostDetail proxmox is null for non-linked host', () => {
    seedHost(db, 'bare');
    const detail = getHostDetail(db, 'bare', 10);
    assert.ok(detail);
    assert.equal(detail.proxmox, null);
  });
});
