import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestPendingPods } = require('../../hub/src/ingest');

interface PendingPodRow {
  cluster_id: string;
  namespace: string;
  pod_name: string;
  reason: string | null;
  message: string | null;
  pod_phase: string;
  workload_kind: string | null;
  workload_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function tick(ms = 5): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function seed(ns: string, podName: string, reason = 'Unschedulable', message = 'no nodes') {
  return {
    namespace: ns,
    podName,
    reason,
    message,
    podPhase: 'Pending',
    podCreatedAt: '2026-04-30T10:00:00Z',
    workloadKind: 'ReplicaSet',
    workloadName: podName.replace(/-\w+$/, ''),
  };
}

describe('ingestPendingPods', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('upserts on (cluster_id, namespace, pod_name) — preserves first_seen_at across cycles', async () => {
    ingestPendingPods(db, 'c1', [seed('default', 'web-7d-xyz', 'Unschedulable', 'msg-1')]);
    const before = db.prepare('SELECT * FROM pending_pods').get() as PendingPodRow;
    await tick();
    ingestPendingPods(db, 'c1', [seed('default', 'web-7d-xyz', 'Unschedulable', 'msg-2')]);
    const after = db.prepare('SELECT * FROM pending_pods').get() as PendingPodRow;
    assert.equal(after.first_seen_at, before.first_seen_at, 'first_seen_at preserved');
    assert.notEqual(after.last_seen_at, before.last_seen_at, 'last_seen_at advances');
    assert.equal(after.message, 'msg-2', 'mutable fields update');
  });

  it('deletes pods absent from a later batch (left Pending or removed)', async () => {
    ingestPendingPods(db, 'c1', [
      seed('default', 'a-pod'),
      seed('default', 'b-pod'),
    ]);
    await tick();
    // Batch 2 only has 'a-pod' — 'b-pod' should be pruned
    ingestPendingPods(db, 'c1', [seed('default', 'a-pod')]);
    const rows = db.prepare('SELECT pod_name FROM pending_pods ORDER BY pod_name').all() as { pod_name: string }[];
    assert.deepEqual(rows.map(r => r.pod_name), ['a-pod']);
  });

  it('scopes pruning to cluster_id — other clusters untouched', async () => {
    ingestPendingPods(db, 'c1', [seed('default', 'a-pod')]);
    ingestPendingPods(db, 'c2', [seed('default', 'b-pod')]);
    await tick();
    ingestPendingPods(db, 'c1', []); // c1 has no more pending pods
    const c2 = db.prepare('SELECT pod_name FROM pending_pods WHERE cluster_id = ?').all('c2') as { pod_name: string }[];
    assert.deepEqual(c2.map(r => r.pod_name), ['b-pod'], 'c2 still has its row');
    const c1 = db.prepare('SELECT pod_name FROM pending_pods WHERE cluster_id = ?').all('c1') as { pod_name: string }[];
    assert.deepEqual(c1, []);
  });

  it('stores nullable fields without choking', () => {
    ingestPendingPods(db, 'c1', [{
      namespace: 'default',
      podName: 'standalone',
      reason: null,
      message: null,
      podPhase: 'Pending',
      podCreatedAt: null,
      workloadKind: null,
      workloadName: null,
    }]);
    const row = db.prepare('SELECT * FROM pending_pods').get() as PendingPodRow;
    assert.equal(row.reason, null);
    assert.equal(row.workload_kind, null);
  });
});
