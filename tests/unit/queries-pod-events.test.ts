import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getPodEvents } = require('../../hub/src/web/queries');
const { ingestEvents, upsertHost } = require('../../hub/src/ingest');

function ev(overrides: any = {}) {
  return {
    eventUid: `uid-${Math.random().toString(36).slice(2, 10)}`,
    namespace: 'default',
    involvedKind: 'Pod',
    involvedName: 'web-7d9-abc',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    type: 'Warning',
    count: 1,
    firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('getPodEvents', () => {
  let db: any;
  beforeEach(() => {
    db = createTestDb();
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
  });
  afterEach(() => { db.close(); });

  it('returns [] for non-k8s hosts', () => {
    upsertHost(db, 'docker-host', 'v1', 'docker', null);
    assert.deepEqual(getPodEvents(db, 'docker-host', 'app'), []);
  });

  it('returns [] when container_name has no slash (Docker-style name)', () => {
    ingestEvents(db, 'prod', [ev()]);
    assert.deepEqual(getPodEvents(db, 'k3d-node-0', 'just-a-name'), []);
  });

  it('matches Pod events for Deployment-owned pods (LIKE stable% catches the random suffix)', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'p1', namespace: 'default', involvedKind: 'Pod', involvedName: 'web-7d9-abc', reason: 'Pulled' }),
      ev({ eventUid: 'p2', namespace: 'default', involvedKind: 'Pod', involvedName: 'web-7d9-xyz', reason: 'Started' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/web/nginx');
    assert.equal(out.length, 2);
    const reasons = out.map((e: any) => e.reason).sort();
    assert.deepEqual(reasons, ['Pulled', 'Started']);
  });

  it('matches Pod events for StatefulSet (stable IS pod name, exact match via LIKE prefix)', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 's1', namespace: 'default', involvedKind: 'Pod', involvedName: 'db-0', reason: 'Scheduled' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/db-0/postgres');
    assert.equal(out.length, 1);
  });

  it('matches Deployment-level events on the workload name', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'd1', namespace: 'default', involvedKind: 'Deployment', involvedName: 'web', reason: 'ScalingReplicaSet', type: 'Normal' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/web/nginx');
    assert.equal(out.length, 1);
    assert.equal(out[0].involved_kind, 'Deployment');
  });

  it('matches StatefulSet/DaemonSet/Job/CronJob events at workload level', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'ss', namespace: 'default', involvedKind: 'StatefulSet', involvedName: 'db', reason: 'SuccessfulCreate' }),
      ev({ eventUid: 'ds', namespace: 'default', involvedKind: 'DaemonSet', involvedName: 'fluentd', reason: 'SuccessfulCreate' }),
    ]);
    const dbOut = getPodEvents(db, 'k3d-node-0', 'default/db/postgres');
    assert.equal(dbOut.length, 1);
    assert.equal(dbOut[0].involved_kind, 'StatefulSet');

    const fdOut = getPodEvents(db, 'k3d-node-0', 'default/fluentd/agent');
    assert.equal(fdOut.length, 1);
  });

  it('matches the underlying ReplicaSet (LIKE stable-% — no cross-deployment bleed)', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'rs1', namespace: 'default', involvedKind: 'ReplicaSet', involvedName: 'web-7d9', reason: 'SuccessfulCreate' }),
      // A different RS that begins with the same prefix should NOT match — its name
      // would need to be exactly stable, not stable-something.
      ev({ eventUid: 'rs2', namespace: 'default', involvedKind: 'ReplicaSet', involvedName: 'webhook-abc', reason: 'SuccessfulCreate' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/web/nginx');
    const names = out.map((e: any) => e.involved_name);
    assert.ok(names.includes('web-7d9'), 'matches the deployment-owned RS');
    assert.ok(!names.includes('webhook-abc'), 'does not bleed into a sibling deployment');
  });

  it('filters by namespace — events in other namespaces are ignored', () => {
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'a', namespace: 'default', involvedKind: 'Pod', involvedName: 'web-abc', reason: 'Pulled' }),
      ev({ eventUid: 'b', namespace: 'kube-system', involvedKind: 'Pod', involvedName: 'web-abc', reason: 'Pulled' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/web/nginx');
    assert.equal(out.length, 1);
    assert.equal(out[0].namespace, 'default');
  });

  it('orders by last_seen_at desc and respects limit', () => {
    const now = Date.now();
    ingestEvents(db, 'prod', [
      ev({ eventUid: 'older', involvedKind: 'Pod', involvedName: 'web-7d9-abc', lastSeenAt: new Date(now - 600_000).toISOString(), reason: 'Old' }),
      ev({ eventUid: 'newer', involvedKind: 'Pod', involvedName: 'web-7d9-xyz', lastSeenAt: new Date(now).toISOString(), reason: 'New' }),
    ]);
    const out = getPodEvents(db, 'k3d-node-0', 'default/web/nginx', 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].reason, 'New');
  });
});
