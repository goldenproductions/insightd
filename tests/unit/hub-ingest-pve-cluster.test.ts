import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestPveCluster, upsertHost } = require('../../hub/src/ingest');

interface HostRow { host_id: string; proxmox_cluster_id: string | null }
interface ClusterRow { cluster_name: string; quorate: number; total_nodes: number; online_nodes: number }

function status(clusterName: string, overrides: Partial<{ quorate: number; totalNodes: number; onlineNodes: number }> = {}) {
  return {
    clusterName,
    quorate: overrides.quorate ?? 1,
    totalNodes: overrides.totalNodes ?? 3,
    onlineNodes: overrides.onlineNodes ?? 3,
  };
}

describe('ingestPveCluster', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('seeds hosts.proxmox_cluster_id for the publishing PVE node', () => {
    upsertHost(db, 'proxmox-01');
    ingestPveCluster(db, 'proxmox-01', status('homelab'));
    const cluster = db.prepare('SELECT * FROM pve_cluster_status WHERE cluster_name = ?').get('homelab') as ClusterRow | undefined;
    assert.ok(cluster, 'pve_cluster_status row exists');
    assert.equal(cluster!.quorate, 1);
    const host = db.prepare('SELECT host_id, proxmox_cluster_id FROM hosts WHERE host_id = ?').get('proxmox-01') as HostRow | undefined;
    assert.equal(host?.proxmox_cluster_id, 'homelab');
  });

  it('updates host cluster_id when the cluster is renamed', () => {
    upsertHost(db, 'proxmox-01');
    ingestPveCluster(db, 'proxmox-01', status('old-name'));
    ingestPveCluster(db, 'proxmox-01', status('new-name'));
    const host = db.prepare('SELECT proxmox_cluster_id FROM hosts WHERE host_id = ?').get('proxmox-01') as HostRow | undefined;
    assert.equal(host?.proxmox_cluster_id, 'new-name');
  });

  it('is a silent no-op when the host row does not yet exist', () => {
    ingestPveCluster(db, 'unknown-node', status('homelab'));
    const cluster = db.prepare('SELECT * FROM pve_cluster_status WHERE cluster_name = ?').get('homelab') as ClusterRow | undefined;
    assert.ok(cluster, 'pve_cluster_status row written even without host row');
    const host = db.prepare('SELECT host_id FROM hosts WHERE host_id = ?').get('unknown-node') as HostRow | undefined;
    assert.equal(host, undefined, 'no host row created by ingestPveCluster');
  });

  it('does not modify other host rows', () => {
    upsertHost(db, 'proxmox-01');
    upsertHost(db, 'other-host');
    ingestPveCluster(db, 'proxmox-01', status('homelab'));
    const other = db.prepare('SELECT proxmox_cluster_id FROM hosts WHERE host_id = ?').get('other-host') as HostRow | undefined;
    assert.equal(other?.proxmox_cluster_id, null);
  });
});
