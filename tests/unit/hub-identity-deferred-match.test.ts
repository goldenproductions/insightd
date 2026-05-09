import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
import { handleIdentityHint, rematchAllPendingHints, rememberIdentityHint } from '../../hub/src/mqtt';

test('hint received before PVE inventory; later inventory triggers match', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id) VALUES ('vm1')`).run();

  // Hint arrives first; no PVE data yet
  rememberIdentityHint('vm1', { virt_type: 'qemu', system_uuid: 'uuid-1', hostname: 'vm1', primary_mac: null });
  handleIdentityHint(db, 'vm1', { virt_type: 'qemu', system_uuid: 'uuid-1', hostname: 'vm1', primary_mac: null });
  let row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='vm1'`).get() as any;
  assert.equal(row.proxmox_vmid, null);

  // PVE inventory arrives — seed PVE node host with cluster_id (since matcher derives via JOIN)
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO hosts (host_id, proxmox_cluster_id) VALUES ('pve1', 'c1')`).run();
  db.prepare(`INSERT INTO container_snapshots
    (host_id, container_id, container_name, guest_vmid, guest_type, guest_uuid, collected_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`).run('pve1', 'pve1/100', 'vm1', 100, 'qemu', 'uuid-1', ts);

  rematchAllPendingHints(db);

  row = db.prepare(`SELECT proxmox_vmid FROM hosts WHERE host_id='vm1'`).get() as any;
  assert.equal(row.proxmox_vmid, 100);
});
