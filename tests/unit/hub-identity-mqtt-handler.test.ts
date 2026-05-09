import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
import { handleIdentityHint } from '../../hub/src/mqtt';

function seedHost(db: any, hostId: string, opts: { proxmoxClusterId?: string; proxmoxVmid?: number; proxmoxNode?: string; proxmoxGuestType?: string } = {}) {
  db.prepare(`INSERT OR IGNORE INTO hosts (host_id, proxmox_cluster_id, proxmox_node, proxmox_vmid, proxmox_guest_type)
              VALUES (?, ?, ?, ?, ?)`).run(
    hostId,
    opts.proxmoxClusterId ?? null, opts.proxmoxNode ?? null, opts.proxmoxVmid ?? null, opts.proxmoxGuestType ?? null
  );
}

function seedGuest(db: any, opts: any) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
      opts.node, `${opts.node}/${opts.vmid}`, `${opts.node}/${opts.name}`, opts.vmid, opts.type,
      opts.uuid ?? null, opts.mac ?? null, ts);
  // Also seed the PVE node host with cluster_id, since matcher derives it from hosts join
  seedHost(db, opts.node, { proxmoxClusterId: opts.cluster_id });
}

test('writes proxmox link on match', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedHost(db, 'web01');
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01' });

  handleIdentityHint(db, 'web01', {
    virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null,
  });

  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_node, proxmox_vmid, proxmox_guest_type FROM hosts WHERE host_id='web01'`).get() as any;
  assert.equal(row.proxmox_node, 'pve1');
  assert.equal(row.proxmox_vmid, 200);
  assert.equal(row.proxmox_guest_type, 'lxc');
});

test('NULLs link when previously linked but no longer matches', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedHost(db, 'web01', { proxmoxClusterId: 'old', proxmoxNode: 'oldnode', proxmoxVmid: 999, proxmoxGuestType: 'lxc' });

  handleIdentityHint(db, 'web01', {
    virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null,
  });

  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_vmid FROM hosts WHERE host_id='web01'`).get() as any;
  assert.equal(row.proxmox_cluster_id, null);
  assert.equal(row.proxmox_vmid, null);
});

test('bare hint is no-op (does not clear existing link)', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedHost(db, 'h', { proxmoxClusterId: 'c1', proxmoxVmid: 100, proxmoxNode: 'pve1', proxmoxGuestType: 'qemu' });

  handleIdentityHint(db, 'h', { virt_type: 'bare' as any, system_uuid: null, hostname: 'h', primary_mac: null });

  const row = db.prepare(`SELECT proxmox_cluster_id, proxmox_vmid FROM hosts WHERE host_id='h'`).get() as any;
  assert.equal(row.proxmox_cluster_id, 'c1');
  assert.equal(row.proxmox_vmid, 100);
});
