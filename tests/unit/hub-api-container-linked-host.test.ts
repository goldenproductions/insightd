import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database = require('better-sqlite3');
const { bootstrap } = require('../../hub/src/db/schema') as { bootstrap: (db: Database.Database) => void };
const { getContainerLinkedHostId } = require('../../hub/src/web/queries');

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

function seedContainerSnapshot(db: Database.Database, opts: {
  hostId: string; containerName: string; containerId: string;
  guestVmid?: number | null; guestType?: string | null; status?: string;
}) {
  // Insert into containers registry (used by some queries)
  db.prepare(`
    INSERT OR IGNORE INTO containers (host_id, container_name, first_seen, last_seen)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `).run(opts.hostId, opts.containerName);
  db.prepare(`
    INSERT INTO container_snapshots
    (host_id, container_name, container_id, status, guest_vmid, guest_type, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    opts.hostId, opts.containerName, opts.containerId,
    opts.status ?? 'running',
    opts.guestVmid ?? null, opts.guestType ?? null,
  );
}

describe('getContainerLinkedHostId', () => {
  let db: Database.Database;

  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it('returns linkedHostId when guest matches a bridged host via proxmox_node+proxmox_vmid', () => {
    // In-guest agent host with proxmox bridge columns set
    seedHost(db, 'vm1', { proxmox_node: 'pve1', proxmox_vmid: 108, proxmox_guest_type: 'qemu' });
    // PVE hypervisor host observing this guest
    seedHost(db, 'pve1');
    seedContainerSnapshot(db, { hostId: 'pve1', containerName: 'pve1/108', containerId: 'pve1/108', guestVmid: 108, guestType: 'qemu' });

    const result = getContainerLinkedHostId(db, 'pve1/108');
    assert.equal(result, 'vm1');
  });

  it('returns null for a container with no matching host bridge', () => {
    seedHost(db, 'pve1');
    seedContainerSnapshot(db, { hostId: 'pve1', containerName: 'pve1/200', containerId: 'pve1/200', guestVmid: 200, guestType: 'lxc' });

    const result = getContainerLinkedHostId(db, 'pve1/200');
    assert.equal(result, null);
  });

  it('returns null when container has no guest_vmid', () => {
    seedHost(db, 'docker1');
    seedContainerSnapshot(db, { hostId: 'docker1', containerName: 'nginx', containerId: 'abc123def456', guestVmid: null });

    const result = getContainerLinkedHostId(db, 'abc123def456');
    assert.equal(result, null);
  });

  it('returns null for unknown container_id', () => {
    const result = getContainerLinkedHostId(db, 'nonexistent-id');
    assert.equal(result, null);
  });
});
