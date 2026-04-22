import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getPvsOverview } = require('../../hub/src/web/queries');
const { ingestPvs, ingestPvcs } = require('../../hub/src/ingest');

function ts(offsetSec: number = 0): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

describe('getPvsOverview', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty result when no data', () => {
    const o = getPvsOverview(db);
    assert.equal(o.totals.pvCount, 0);
    assert.equal(o.totals.clusterCount, 0);
    assert.deepEqual(o.clusters, []);
  });

  it('joins a PV to its bound PVC', () => {
    ingestPvs(db, 'prod', [{
      name: 'pv-001', phase: 'Bound', capacityBytes: 10 * 1024 ** 3,
      accessModes: ['ReadWriteOnce'], reclaimPolicy: 'Delete',
      storageClass: 'local-path', volumeMode: 'Filesystem',
      claimNamespace: 'app', claimName: 'data',
      csiDriver: null, createdAt: null, labels: null,
    }]);
    ingestPvcs(db, 'prod', [{
      namespace: 'app', name: 'data', phase: 'Bound',
      storageClass: 'local-path', requestBytes: 5 * 1024 ** 3, capacityBytes: 10 * 1024 ** 3,
      accessModes: ['ReadWriteOnce'], volumeName: 'pv-001', volumeMode: 'Filesystem',
      createdAt: null, labels: null,
    }]);

    const o = getPvsOverview(db);
    assert.equal(o.totals.pvCount, 1);
    assert.equal(o.totals.pvcCount, 1);
    assert.equal(o.totals.clusterCount, 1);
    const cluster = o.clusters[0];
    assert.equal(cluster.clusterId, 'prod');
    assert.equal(cluster.pvs[0].name, 'pv-001');
    assert.ok(cluster.pvs[0].boundPvc, 'PV should be joined to its PVC');
    assert.equal(cluster.pvs[0].boundPvc.name, 'data');
  });

  it('counts Released PVs as orphaned', () => {
    ingestPvs(db, 'prod', [
      { name: 'pv-bound',    phase: 'Bound',    capacityBytes: 1e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
      { name: 'pv-released', phase: 'Released', capacityBytes: 2e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
    ]);
    const o = getPvsOverview(db);
    assert.equal(o.totals.pvCount, 2);
    assert.equal(o.totals.boundCount, 1);
    assert.equal(o.totals.releasedCount, 1);
    assert.equal(o.totals.orphanedCount, 1);
    assert.equal(o.totals.orphanedCapacityBytes, 2e9);
    const released = o.clusters[0].pvs.find((p: any) => p.name === 'pv-released');
    assert.equal(released.orphaned, true);
    const bound = o.clusters[0].pvs.find((p: any) => p.name === 'pv-bound');
    assert.equal(bound.orphaned, false);
  });

  it('separates clusters and marks stale ones offline', () => {
    // Fresh cluster
    ingestPvs(db, 'fresh', [
      { name: 'pv-new', phase: 'Available', capacityBytes: 1e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
    ]);
    // Stale cluster — backdate the row directly
    ingestPvs(db, 'stale', [
      { name: 'pv-old', phase: 'Bound', capacityBytes: 2e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
    ]);
    db.prepare(`UPDATE pv_snapshots SET collected_at = ? WHERE cluster_id = 'stale'`).run(ts(-3600));

    const o = getPvsOverview(db, 15);
    assert.equal(o.totals.clusterCount, 2);
    const fresh = o.clusters.find((c: any) => c.clusterId === 'fresh');
    const stale = o.clusters.find((c: any) => c.clusterId === 'stale');
    assert.equal(fresh.online, true);
    assert.equal(stale.online, false);
  });

  it('uses only the latest batch per cluster', () => {
    // Old batch — simulates a previous cycle that included pv-a
    ingestPvs(db, 'prod', [
      { name: 'pv-a', phase: 'Bound', capacityBytes: 1e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
    ]);
    db.prepare(`UPDATE pv_snapshots SET collected_at = ? WHERE pv_name = 'pv-a'`).run(ts(-120));

    // Newer batch — only pv-b, meaning pv-a was deleted
    ingestPvs(db, 'prod', [
      { name: 'pv-b', phase: 'Bound', capacityBytes: 2e9, accessModes: [], reclaimPolicy: null, storageClass: null, volumeMode: null, claimNamespace: null, claimName: null, csiDriver: null, createdAt: null, labels: null },
    ]);

    const o = getPvsOverview(db);
    assert.equal(o.totals.pvCount, 1);
    assert.equal(o.clusters[0].pvs[0].name, 'pv-b');
  });

  it('counts PVCs pending', () => {
    ingestPvcs(db, 'prod', [
      { namespace: 'app', name: 'ready',   phase: 'Bound',   storageClass: null, requestBytes: 1e9, capacityBytes: 1e9, accessModes: [], volumeName: 'pv-x', volumeMode: null, createdAt: null, labels: null },
      { namespace: 'app', name: 'waiting', phase: 'Pending', storageClass: null, requestBytes: 1e9, capacityBytes: null, accessModes: [], volumeName: null,    volumeMode: null, createdAt: null, labels: null },
    ]);
    const o = getPvsOverview(db);
    assert.equal(o.totals.pvcCount, 2);
    assert.equal(o.totals.pvcPendingCount, 1);
  });
});
