import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getK8sEventsForHost, getClusterIdForHost } = require('../../hub/src/web/queries');
const { ingestEvents, upsertHost } = require('../../hub/src/ingest');

function sampleEvent(overrides: any = {}) {
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

describe('getClusterIdForHost', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null for non-k8s hosts', () => {
    upsertHost(db, 'docker-host', 'v1', 'docker', null);
    assert.equal(getClusterIdForHost(db, 'docker-host'), null);
  });

  it('returns host_group when set', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod-cluster');
    assert.equal(getClusterIdForHost(db, 'k3d-node-0'), 'prod-cluster');
  });

  it('falls back to cluster-{hostId} when host_group is empty (matches agent)', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', null);
    assert.equal(getClusterIdForHost(db, 'k3d-node-0'), 'cluster-k3d-node-0');
  });

  it('returns null for unknown host', () => {
    assert.equal(getClusterIdForHost(db, 'nonexistent'), null);
  });
});

describe('getK8sEventsForHost', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty for non-k8s hosts', () => {
    upsertHost(db, 'docker-host', 'v1', 'docker', null);
    ingestEvents(db, 'prod', [sampleEvent()]);
    assert.deepEqual(getK8sEventsForHost(db, 'docker-host'), []);
  });

  it('returns events from the host\'s cluster, sorted by last_seen_at DESC', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
    const older = sampleEvent({ eventUid: 'older', lastSeenAt: '2026-04-23T09:00:00Z' });
    const newer = sampleEvent({ eventUid: 'newer', lastSeenAt: '2026-04-23T10:00:00Z' });
    ingestEvents(db, 'prod', [older, newer]);

    const rows = getK8sEventsForHost(db, 'k3d-node-0');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event_uid, 'newer');
    assert.equal(rows[1].event_uid, 'older');
  });

  it('excludes events from other clusters', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
    ingestEvents(db, 'prod', [sampleEvent({ eventUid: 'a' })]);
    ingestEvents(db, 'staging', [sampleEvent({ eventUid: 'b' })]);

    const rows = getK8sEventsForHost(db, 'k3d-node-0');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_uid, 'a');
  });

  it('filters by reason', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
    ingestEvents(db, 'prod', [
      sampleEvent({ eventUid: 'a', reason: 'BackOff' }),
      sampleEvent({ eventUid: 'b', reason: 'Unhealthy' }),
      sampleEvent({ eventUid: 'c', reason: 'BackOff' }),
    ]);
    const rows = getK8sEventsForHost(db, 'k3d-node-0', { reason: 'BackOff' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r: any) => r.reason === 'BackOff'));
  });

  it('filters by namespace', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
    ingestEvents(db, 'prod', [
      sampleEvent({ eventUid: 'a', namespace: 'default' }),
      sampleEvent({ eventUid: 'b', namespace: 'kube-system' }),
    ]);
    const rows = getK8sEventsForHost(db, 'k3d-node-0', { namespace: 'kube-system' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].namespace, 'kube-system');
  });

  it('honors limit', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'prod');
    const events = Array.from({ length: 5 }, (_, i) =>
      sampleEvent({ eventUid: `e${i}`, lastSeenAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    ingestEvents(db, 'prod', events);
    const rows = getK8sEventsForHost(db, 'k3d-node-0', { limit: 2 });
    assert.equal(rows.length, 2);
  });

  it('respects host_group_override when set', () => {
    upsertHost(db, 'k3d-node-0', 'v1', 'kubernetes', 'agent-reported');
    db.prepare("UPDATE hosts SET host_group_override = ? WHERE host_id = ?").run('ui-override', 'k3d-node-0');
    ingestEvents(db, 'ui-override', [sampleEvent({ eventUid: 'ov' })]);
    ingestEvents(db, 'agent-reported', [sampleEvent({ eventUid: 'agent' })]);

    const rows = getK8sEventsForHost(db, 'k3d-node-0');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_uid, 'ov', 'UI override should win over agent-reported host_group');
  });
});
