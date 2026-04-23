import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getNodeConditionsForHost } = require('../../hub/src/web/queries');
const { ingestNodeConditions, upsertHost } = require('../../hub/src/ingest');

function cond(overrides: any = {}) {
  return {
    type: 'Ready',
    status: 'True',
    reason: 'KubeletReady',
    message: 'kubelet is posting ready status',
    lastHeartbeatAt: new Date().toISOString(),
    lastTransitionAt: new Date(Date.now() - 3600_000).toISOString(),
    ...overrides,
  };
}

describe('getNodeConditionsForHost', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty array when no conditions are stored', () => {
    upsertHost(db, 'k3d-0', 'v1', 'kubernetes', 'prod');
    assert.deepEqual(getNodeConditionsForHost(db, 'k3d-0'), []);
  });

  it('returns all conditions for the host, Ready pinned first', () => {
    upsertHost(db, 'k3d-0', 'v1', 'kubernetes', 'prod');
    ingestNodeConditions(db, 'k3d-0', [
      cond({ type: 'MemoryPressure', status: 'False' }),
      cond({ type: 'DiskPressure', status: 'False' }),
      cond({ type: 'Ready', status: 'True' }),
      cond({ type: 'PIDPressure', status: 'False' }),
    ]);
    const rows = getNodeConditionsForHost(db, 'k3d-0');
    assert.equal(rows.length, 4);
    assert.equal(rows[0].type, 'Ready', 'Ready should sort first');
    // Remaining in alphabetical order
    assert.deepEqual(
      rows.slice(1).map((r: any) => r.type),
      ['DiskPressure', 'MemoryPressure', 'PIDPressure'],
    );
  });

  it('does not return conditions from a different host', () => {
    upsertHost(db, 'k3d-0', 'v1', 'kubernetes', 'prod');
    upsertHost(db, 'k3d-1', 'v1', 'kubernetes', 'prod');
    ingestNodeConditions(db, 'k3d-0', [cond({ type: 'MemoryPressure', status: 'True' })]);
    ingestNodeConditions(db, 'k3d-1', [cond({ type: 'DiskPressure', status: 'True' })]);

    const rows = getNodeConditionsForHost(db, 'k3d-0');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'MemoryPressure');
  });

  it('UPSERT: second ingest replaces the status without duplicating rows', () => {
    upsertHost(db, 'k3d-0', 'v1', 'kubernetes', 'prod');
    ingestNodeConditions(db, 'k3d-0', [cond({ type: 'MemoryPressure', status: 'True', reason: 'KubeletHasInsufficientMemory' })]);
    ingestNodeConditions(db, 'k3d-0', [cond({ type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory' })]);

    const rows = getNodeConditionsForHost(db, 'k3d-0');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'False');
    assert.equal(rows[0].reason, 'KubeletHasSufficientMemory');
  });
});
