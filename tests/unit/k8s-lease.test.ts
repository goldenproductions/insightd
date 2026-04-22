import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLeaseExpired, createLeaderElector } from '../../agent/src/runtime/k8s-lease';
import type { K8sLease, K8sClient } from '../../agent/src/runtime/kubernetes';

describe('isLeaseExpired', () => {
  const now = Date.parse('2026-04-22T12:00:00Z');

  it('treats missing renewTime as expired', () => {
    assert.equal(isLeaseExpired({ spec: { leaseDurationSeconds: 15 } }, now), true);
  });

  it('treats unparseable renewTime as expired', () => {
    assert.equal(isLeaseExpired({ spec: { renewTime: 'nonsense', leaseDurationSeconds: 15 } }, now), true);
  });

  it('fresh lease (renewed 5s ago, 15s TTL) is not expired', () => {
    const renew = new Date(now - 5000).toISOString();
    assert.equal(isLeaseExpired({ spec: { renewTime: renew, leaseDurationSeconds: 15 } }, now), false);
  });

  it('just past TTL is expired', () => {
    const renew = new Date(now - 16_000).toISOString();
    assert.equal(isLeaseExpired({ spec: { renewTime: renew, leaseDurationSeconds: 15 } }, now), true);
  });

  it('exactly at TTL boundary is NOT expired (strictly greater than)', () => {
    const renew = new Date(now - 15_000).toISOString();
    assert.equal(isLeaseExpired({ spec: { renewTime: renew, leaseDurationSeconds: 15 } }, now), false);
  });

  it('defaults TTL to 15s when missing', () => {
    const renew = new Date(now - 14_000).toISOString();
    assert.equal(isLeaseExpired({ spec: { renewTime: renew } }, now), false);
  });
});

// ── LeaderElector state machine ─────────────────────────────────────────
// Stub client that records calls and lets tests script responses.

interface FakeClientState {
  lease: K8sLease | null;
  nextCreateStatus: number;
  nextUpdateStatus: number;
  creates: K8sLease[];
  updates: K8sLease[];
}

function makeFakeClient(state: FakeClientState): K8sClient {
  return {
    async getLease(_ns: string, _name: string) {
      return state.lease;
    },
    async createLease(_ns: string, lease: K8sLease) {
      state.creates.push(lease);
      if (state.nextCreateStatus === 201 || state.nextCreateStatus === 200) {
        state.lease = { ...lease, metadata: { ...(lease.metadata || {}), resourceVersion: 'rv1' } };
      }
      return { status: state.nextCreateStatus, body: state.lease };
    },
    async updateLease(_ns: string, _name: string, lease: K8sLease) {
      state.updates.push(lease);
      if (state.nextUpdateStatus === 200) {
        state.lease = { ...lease, metadata: { ...(lease.metadata || {}), resourceVersion: 'rv2' } };
      }
      return { status: state.nextUpdateStatus, body: state.lease };
    },
  } as unknown as K8sClient;
}

describe('createLeaderElector', () => {
  it('acquires a new lease when none exists', async () => {
    const state: FakeClientState = { lease: null, nextCreateStatus: 201, nextUpdateStatus: 200, creates: [], updates: [] };
    const elector = createLeaderElector({
      client: makeFakeClient(state),
      namespace: 'ns', leaseName: 'lock', identity: 'pod-a',
    });
    // Drive the state machine manually: we don't call start() so that we can
    // await a single tryAcquire by reaching through the public isLeader() after.
    // Workaround — start() kicks off an async tryAcquire; give it a microtask.
    elector.start();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await elector.stop();
    assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0].spec?.holderIdentity, 'pod-a');
  });

  it('stays standby when another pod holds a fresh lease', async () => {
    const freshRenew = new Date(Date.now() - 2000).toISOString();
    const state: FakeClientState = {
      lease: {
        metadata: { name: 'lock', namespace: 'ns', resourceVersion: 'rv0' },
        spec: { holderIdentity: 'pod-b', leaseDurationSeconds: 15, renewTime: freshRenew, acquireTime: freshRenew, leaseTransitions: 1 },
      },
      nextCreateStatus: 500, nextUpdateStatus: 500, creates: [], updates: [],
    };
    const elector = createLeaderElector({
      client: makeFakeClient(state),
      namespace: 'ns', leaseName: 'lock', identity: 'pod-a',
    });
    elector.start();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(elector.isLeader(), false);
    assert.equal(state.creates.length, 0);
    assert.equal(state.updates.length, 0);
    await elector.stop();
  });

  it('steals an expired lease from a dead holder', async () => {
    const staleRenew = new Date(Date.now() - 30_000).toISOString();
    const state: FakeClientState = {
      lease: {
        metadata: { name: 'lock', namespace: 'ns', resourceVersion: 'rv0' },
        spec: { holderIdentity: 'pod-dead', leaseDurationSeconds: 15, renewTime: staleRenew, acquireTime: staleRenew, leaseTransitions: 3 },
      },
      nextCreateStatus: 500, nextUpdateStatus: 200, creates: [], updates: [],
    };
    const elector = createLeaderElector({
      client: makeFakeClient(state),
      namespace: 'ns', leaseName: 'lock', identity: 'pod-a',
    });
    elector.start();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0].spec?.holderIdentity, 'pod-a');
    // leaseTransitions should bump when stealing
    assert.equal(state.updates[0].spec?.leaseTransitions, 4);
    assert.equal(elector.isLeader(), true);
    await elector.stop();
  });

  it('loses acquire race on 409 conflict', async () => {
    const state: FakeClientState = { lease: null, nextCreateStatus: 409, nextUpdateStatus: 500, creates: [], updates: [] };
    const elector = createLeaderElector({
      client: makeFakeClient(state),
      namespace: 'ns', leaseName: 'lock', identity: 'pod-a',
    });
    elector.start();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(elector.isLeader(), false);
    await elector.stop();
  });

  it('readopts its own lease on restart', async () => {
    const state: FakeClientState = {
      lease: {
        metadata: { name: 'lock', namespace: 'ns', resourceVersion: 'rv0' },
        spec: { holderIdentity: 'pod-a', leaseDurationSeconds: 15, renewTime: new Date().toISOString() },
      },
      nextCreateStatus: 500, nextUpdateStatus: 200, creates: [], updates: [],
    };
    const elector = createLeaderElector({
      client: makeFakeClient(state),
      namespace: 'ns', leaseName: 'lock', identity: 'pod-a',
    });
    elector.start();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(elector.isLeader(), true);
    await elector.stop();
  });
});
