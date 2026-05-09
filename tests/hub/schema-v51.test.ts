import { test } from 'node:test';
import assert from 'node:assert/strict';
const Database = require('better-sqlite3');
const { bootstrap } = require('../../hub/src/db/schema');

test('v51 adds proxmox link columns to hosts and uuid/mac to container_snapshots', () => {
  const db = new Database(':memory:');
  bootstrap(db);

  const hostsCols = db.prepare("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
  const names = new Set(hostsCols.map(c => c.name));
  assert.ok(names.has('proxmox_cluster_id'));
  assert.ok(names.has('proxmox_node'));
  assert.ok(names.has('proxmox_vmid'));
  assert.ok(names.has('proxmox_guest_type'));

  const csCols = db.prepare("PRAGMA table_info(container_snapshots)").all() as Array<{ name: string }>;
  const csNames = new Set(csCols.map(c => c.name));
  assert.ok(csNames.has('guest_uuid'));
  assert.ok(csNames.has('guest_primary_mac'));

  const indexes = db.prepare("PRAGMA index_list(hosts)").all() as Array<{ name: string }>;
  assert.ok(indexes.some(i => i.name === 'hosts_proxmox_link'));

  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
  assert.equal(parseInt(version.value, 10), 51);
});
