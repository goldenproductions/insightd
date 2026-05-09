import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
import { matchIdentityHint, IdentityHint } from '../../hub/src/identity/matcher';

/**
 * Seeds a Proxmox guest into the DB.
 *
 * In production, PVE container snapshots arrive from the PVE hypervisor agent.
 * The agent publishes rows into container_snapshots where:
 *   host_id         = node name (e.g. 'pve1')
 *   container_name  = '<node>/<displayName>'  (e.g. 'pve1/vm1')
 *   container_id    = '<node>/<vmid>'
 *   guest_type      = 'qemu' | 'lxc'
 *   guest_vmid      = numeric VMID
 *   guest_uuid      = SMBIOS UUID (qemu only)
 *   guest_primary_mac = eth0 MAC (lxc / in-guest probe)
 *
 * The cluster_id comes from hosts.proxmox_cluster_id (set when the PVE
 * hypervisor agent registers itself). We seed the hosts row here so the
 * matcher's JOIN works.
 */
function seedGuest(db: any, opts: {
  cluster_id: string; node: string; vmid: number; type: 'qemu' | 'lxc';
  name: string; uuid?: string; mac?: string;
}) {
  // Ensure the hypervisor host row exists with the right cluster_id.
  db.prepare(`
    INSERT OR IGNORE INTO hosts (host_id, proxmox_cluster_id)
    VALUES (?, ?)
  `).run(opts.node, opts.cluster_id);

  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO container_snapshots
      (host_id, container_id, container_name, guest_vmid, guest_type, guest_uuid, guest_primary_mac, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    opts.node,
    `${opts.node}/${opts.vmid}`,
    `${opts.node}/${opts.name}`,
    opts.vmid,
    opts.type,
    opts.uuid ?? null,
    opts.mac ?? null,
    ts,
  );
}

test('qemu match by UUID', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 100, type: 'qemu', name: 'vm1', uuid: 'aaa-bbb' });
  const hint: IdentityHint = { virt_type: 'qemu', system_uuid: 'AAA-BBB', hostname: 'h', primary_mac: null };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 100, guest_type: 'qemu' });
});

test('lxc match by hostname', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 200, type: 'lxc', name: 'web01' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'web01', primary_mac: null };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 200, guest_type: 'lxc' });
});

test('lxc match by MAC when hostname differs', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 201, type: 'lxc', name: 'config-name', mac: 'bc:24:11:00:00:09' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'kernel-name', primary_mac: 'bc:24:11:00:00:09' };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.deepEqual(result, { cluster_id: 'c1', node: 'pve1', vmid: 201, guest_type: 'lxc' });
});

test('lxc both-match preferred when ambiguous on hostname', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 300, type: 'lxc', name: 'dup', mac: 'aa:aa:aa:aa:aa:01' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 301, type: 'lxc', name: 'dup', mac: 'aa:aa:aa:aa:aa:02' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'dup', primary_mac: 'aa:aa:aa:aa:aa:02' };
  const result = matchIdentityHint(db, 'host-x', hint);
  assert.equal(result?.vmid, 301);
});

test('lxc ambiguous returns null', () => {
  const db = new Database(':memory:'); bootstrap(db);
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 400, type: 'lxc', name: 'dup' });
  seedGuest(db, { cluster_id: 'c1', node: 'pve1', vmid: 401, type: 'lxc', name: 'dup' });
  const hint: IdentityHint = { virt_type: 'lxc', system_uuid: null, hostname: 'dup', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});

test('no match returns null', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const hint: IdentityHint = { virt_type: 'qemu', system_uuid: 'unknown', hostname: 'h', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});

test('bare returns null', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const hint: IdentityHint = { virt_type: 'bare' as any, system_uuid: null, hostname: 'h', primary_mac: null };
  assert.equal(matchIdentityHint(db, 'host-x', hint), null);
});
