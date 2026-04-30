import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { getRcaNeighbors } = require('../../hub/src/web/queries');

function insertEdge(db: any, from: string, to: string, edgeType: string, weight: number): void {
  // Match graph.ts addEdge: edges are stored with from < to lex-sorted.
  const a = from < to ? from : to;
  const b = from < to ? to : from;
  db.prepare(`
    INSERT OR REPLACE INTO rca_edges (from_entity, to_entity, edge_type, weight)
    VALUES (?, ?, ?, ?)
  `).run(a, b, edgeType, weight);
}

function ts(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

describe('getRcaNeighbors', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns [] when no edges exist', () => {
    assert.deepEqual(getRcaNeighbors(db, 'h1', 'app'), []);
  });

  it('walks both edge directions (graph stored once with from < to)', () => {
    // 'a-app' < 'z-app' lex, so the edge is stored from='h1/a-app' to='h1/z-app'.
    // Querying from either side must return the other.
    insertEdge(db, 'h1/a-app', 'h1/z-app', 'same_host', 0.3);

    const fromA = getRcaNeighbors(db, 'h1', 'a-app');
    const fromZ = getRcaNeighbors(db, 'h1', 'z-app');
    assert.equal(fromA.length, 1);
    assert.equal(fromA[0].containerName, 'z-app');
    assert.equal(fromZ.length, 1);
    assert.equal(fromZ[0].containerName, 'a-app');
  });

  it('collapses multi-type pairs to one row with strongest weight as score', () => {
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);
    insertEdge(db, 'h1/app', 'h1/db', 'same_compose', 0.6);
    insertEdge(db, 'h1/app', 'h1/db', 'metric_corr', 0.85);

    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out.length, 1, 'one row per neighbor');
    assert.equal(out[0].score, 0.85, 'strongest weight as score');
    assert.deepEqual(out[0].edgeTypes, ['metric_corr', 'same_compose', 'same_host'], 'all types listed, sorted');
  });

  it('orders by score descending and respects limit', () => {
    insertEdge(db, 'h1/app', 'h1/weakest', 'same_host', 0.3);
    insertEdge(db, 'h1/app', 'h1/middle', 'same_compose', 0.6);
    insertEdge(db, 'h1/app', 'h1/strongest', 'metric_corr', 0.95);

    const top2 = getRcaNeighbors(db, 'h1', 'app', 2);
    assert.equal(top2.length, 2);
    assert.equal(top2[0].containerName, 'strongest');
    assert.equal(top2[1].containerName, 'middle');
  });

  it('filters out insightd-* containers (matches detector noise filter)', () => {
    insertEdge(db, 'h1/app', 'h1/insightd-agent', 'same_host', 0.3);
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);

    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out.length, 1);
    assert.equal(out[0].containerName, 'db');
  });

  it('handles k8s-style container names with slashes', () => {
    // K8s entity is "host_id/namespace/stable/container" — split on first slash.
    insertEdge(db, 'k8s-1/app', 'k8s-1/default/web/nginx', 'metric_corr', 0.7);

    const out = getRcaNeighbors(db, 'k8s-1', 'app');
    assert.equal(out.length, 1);
    assert.equal(out[0].hostId, 'k8s-1');
    assert.equal(out[0].containerName, 'default/web/nginx');
  });

  it('attaches health_status from the latest container snapshot', () => {
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'db', health: 'unhealthy', at: ts(Date.now()) },
    ]);
    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out[0].healthStatus, 'unhealthy');
  });

  it('flags hasActiveAlert when the neighbor has an unresolved alert_state row', () => {
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count)
      VALUES ('h1', 'restart_loop', 'db', datetime('now'), datetime('now'), 1)
    `).run();
    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out[0].hasActiveAlert, true);
  });

  it('does not flag hasActiveAlert when the alert is already resolved', () => {
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, resolved_at)
      VALUES ('h1', 'restart_loop', 'db', datetime('now', '-1 hour'), datetime('now', '-1 hour'), 1, datetime('now', '-30 minutes'))
    `).run();
    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out[0].hasActiveAlert, false);
  });

  it('flags isRemoved when the container has no registry row', () => {
    insertEdge(db, 'h1/app', 'h1/ghost', 'same_host', 0.3);
    // No seedContainerSnapshots → no `containers` row for ghost
    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out[0].isRemoved, true);
  });

  it('does not flag isRemoved when containers row is current', () => {
    insertEdge(db, 'h1/app', 'h1/db', 'same_host', 0.3);
    seedContainerSnapshots(db, [{ hostId: 'h1', name: 'db', at: ts(Date.now()) }]);
    const out = getRcaNeighbors(db, 'h1', 'app');
    assert.equal(out[0].isRemoved, false);
  });
});
