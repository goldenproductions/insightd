import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { bootstrap } from '../../hub/src/db/schema';
import { handleIdentityHint, rememberIdentityHint, rematchAllPendingHints } from '../../hub/src/mqtt';

function seedHost(db: any, id: string, opts: { proxmoxClusterId?: string } = {}) {
  db.prepare(`INSERT INTO hosts (host_id, proxmox_cluster_id) VALUES (?, ?)`).run(id, opts.proxmoxClusterId ?? null);
}

function seedGuest(db: any, opts: any) {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_name, container_id, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
      opts.node, `${opts.node}/${opts.name}`, `${opts.node}/${opts.vmid}`, opts.vmid, opts.type,
      opts.uuid ?? null, opts.mac ?? null, ts);

  // Seed PVE node host with cluster_id (matcher derives via JOIN)
  db.prepare(`INSERT OR IGNORE INTO hosts (host_id, proxmox_cluster_id) VALUES (?, ?)`).run(
    opts.node, opts.cluster_id);
}

test('full lifecycle: qemu link, lxc link, bare no-link, deferred match', () => {
  const db = new Database(':memory:');
  bootstrap(db);

  // Seed two PVE guests + three in-guest hosts
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 100, type: 'qemu', name: 'qemu-vm', uuid: 'uuid-qemu' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01', mac: 'bc:24:11:00:00:01' });
  seedHost(db, 'qemu-host');
  seedHost(db, 'lxc-host');
  seedHost(db, 'bare-host');

  // qemu hint -> link
  handleIdentityHint(db, 'qemu-host', { virt_type: 'qemu', system_uuid: 'uuid-qemu', hostname: 'qemu-vm', primary_mac: null });
  let row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='qemu-host'`).get() as any;
  assert.equal(row.proxmox_vmid, 100);

  // lxc hint -> link
  handleIdentityHint(db, 'lxc-host', { virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='lxc-host'`).get() as any;
  assert.equal(row.proxmox_vmid, 200);

  // bare hint -> no link
  handleIdentityHint(db, 'bare-host', { virt_type: 'bare' as any, system_uuid: null, hostname: 'bare', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='bare-host'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  // Deferred match: hint before inventory
  seedHost(db, 'late-vm');
  rememberIdentityHint('late-vm', { virt_type: 'qemu', system_uuid: 'uuid-late', hostname: 'late-vm', primary_mac: null });
  handleIdentityHint(db, 'late-vm', { virt_type: 'qemu', system_uuid: 'uuid-late', hostname: 'late-vm', primary_mac: null });
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='late-vm'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 300, type: 'qemu', name: 'late-vm', uuid: 'uuid-late' });
  rematchAllPendingHints(db);
  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='late-vm'`).get() as any;
  assert.equal(row.proxmox_vmid, 300);
});
