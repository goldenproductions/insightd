import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { findActiveParent, findActiveChildren, DEPS } = require('../hub/src/alerts/dependencies');

function withHost(db: any, host: string, cluster: string | null = null) {
  db.prepare(`
    INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id)
    VALUES (?, datetime('now'), datetime('now'), 'docker', ?)
  `).run(host, cluster);
}

function activeAlert(db: any, host: string, type: string, target: string) {
  db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, pending_since)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(host, type, target);
}

test('host_offline is parent of container_down on same host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h1', target: 'nginx' });
  assert.ok(parent, 'expected parent to be found');
  assert.equal(parent.alert_type, 'host_offline');
});

test('host_offline does not affect a different host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1'); withHost(db, 'h2');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h2', target: 'nginx' });
  assert.equal(parent, null);
});

test('host_offline does not become its own parent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'host_offline', hostId: 'h1', target: 'system' });
  assert.equal(parent, null);
});

test('resolved parents do not suppress', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE alert_type = 'host_offline'").run();
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h1', target: 'nginx' });
  assert.equal(parent, null);
});

test('pve_cluster_quorum_lost is cluster-scoped — matches all hosts in cluster', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'pve-1', 'cluster-A'); withHost(db, 'pve-2', 'cluster-A'); withHost(db, 'pve-x', 'cluster-B');
  activeAlert(db, 'pve-1', 'pve_cluster_quorum_lost', 'cluster-A');
  const sameCluster = findActiveParent(db, { type: 'pve_zfs_unhealthy', hostId: 'pve-2', target: 'tank' });
  assert.ok(sameCluster);
  const otherCluster = findActiveParent(db, { type: 'pve_zfs_unhealthy', hostId: 'pve-x', target: 'tank' });
  assert.equal(otherCluster, null);
});

test('findActiveChildren returns all active host-scoped children for a parent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'container_down', 'nginx');
  activeAlert(db, 'h1', 'restart_loop', 'redis');
  activeAlert(db, 'h1', 'high_cpu', 'worker');
  const children = findActiveChildren(db, { alert_type: 'host_offline', host_id: 'h1' });
  const types = new Set(children.map((c: any) => c.alert_type));
  assert.ok(types.has('container_down'));
  assert.ok(types.has('restart_loop'));
  assert.ok(types.has('high_cpu'));
});

test('DEPS array contains the three documented parents', () => {
  const parents = DEPS.map((d: any) => d.parent);
  assert.deepEqual(parents.sort(), ['host_offline', 'node_not_ready', 'pve_cluster_quorum_lost']);
});
