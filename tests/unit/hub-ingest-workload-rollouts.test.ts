import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestWorkloadRollouts } = require('../../hub/src/ingest');

interface RolloutRow {
  cluster_id: string;
  kind: string;
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  generation: number;
  observed_generation: number;
  progress_deadline_exceeded: number;
  first_seen_at: string;
  last_seen_at: string;
}

function tick(ms = 5): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function seed(opts: Partial<RolloutRow> & { name: string }): any {
  return {
    kind: opts.kind ?? 'Deployment',
    namespace: opts.namespace ?? 'default',
    name: opts.name,
    desired: opts.desired ?? 3,
    ready: opts.ready ?? 3,
    updated: opts.updated ?? 3,
    generation: opts.generation ?? 1,
    observedGeneration: opts.observed_generation ?? 1,
    progressDeadlineExceeded: !!opts.progress_deadline_exceeded,
  };
}

describe('ingestWorkloadRollouts', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('upserts on (cluster_id, kind, namespace, name) — preserves first_seen_at across cycles', async () => {
    ingestWorkloadRollouts(db, 'c1', [seed({ name: 'api', ready: 1 })]);
    const before = db.prepare('SELECT * FROM workload_rollouts').get() as RolloutRow;
    await tick();
    ingestWorkloadRollouts(db, 'c1', [seed({ name: 'api', ready: 3 })]);
    const after = db.prepare('SELECT * FROM workload_rollouts').get() as RolloutRow;
    assert.equal(after.first_seen_at, before.first_seen_at, 'first_seen_at preserved');
    assert.notEqual(after.last_seen_at, before.last_seen_at, 'last_seen_at advances');
    assert.equal(after.ready, 3, 'mutable fields update');
  });

  it('deletes workloads absent from a later batch (workload deleted)', async () => {
    ingestWorkloadRollouts(db, 'c1', [
      seed({ name: 'a' }),
      seed({ name: 'b' }),
    ]);
    await tick();
    ingestWorkloadRollouts(db, 'c1', [seed({ name: 'a' })]);
    const rows = db.prepare('SELECT name FROM workload_rollouts ORDER BY name').all() as { name: string }[];
    assert.deepEqual(rows.map(r => r.name), ['a']);
  });

  it('scopes pruning to cluster_id', async () => {
    ingestWorkloadRollouts(db, 'c1', [seed({ name: 'a' })]);
    ingestWorkloadRollouts(db, 'c2', [seed({ name: 'b' })]);
    await tick();
    ingestWorkloadRollouts(db, 'c1', []);
    const c2 = db.prepare('SELECT name FROM workload_rollouts WHERE cluster_id = ?').all('c2') as { name: string }[];
    assert.deepEqual(c2.map(r => r.name), ['b']);
    const c1 = db.prepare('SELECT name FROM workload_rollouts WHERE cluster_id = ?').all('c1') as { name: string }[];
    assert.deepEqual(c1, []);
  });

  it('keeps Deployment and StatefulSet of the same name as separate rows', () => {
    ingestWorkloadRollouts(db, 'c1', [
      seed({ kind: 'Deployment', name: 'api' }),
      seed({ kind: 'StatefulSet', name: 'api' }),
    ]);
    const rows = db.prepare('SELECT kind FROM workload_rollouts ORDER BY kind').all() as { kind: string }[];
    assert.deepEqual(rows.map(r => r.kind), ['Deployment', 'StatefulSet']);
  });

  it('stores progress_deadline_exceeded as 0/1 INTEGER', () => {
    ingestWorkloadRollouts(db, 'c1', [
      seed({ name: 'stuck', progress_deadline_exceeded: 1 }),
      seed({ name: 'fine' }),
    ]);
    const stuck = db.prepare('SELECT progress_deadline_exceeded FROM workload_rollouts WHERE name = ?').get('stuck') as { progress_deadline_exceeded: number };
    const fine = db.prepare('SELECT progress_deadline_exceeded FROM workload_rollouts WHERE name = ?').get('fine') as { progress_deadline_exceeded: number };
    assert.equal(stuck.progress_deadline_exceeded, 1);
    assert.equal(fine.progress_deadline_exceeded, 0);
  });
});
