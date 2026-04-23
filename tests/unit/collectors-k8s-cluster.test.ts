import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPv, mapPvc, mapEvent } from '../../agent/src/collectors/k8s-cluster';
import type { K8sPv, K8sPvc, K8sEvent } from '../../agent/src/runtime/kubernetes';

describe('mapPv', () => {
  it('maps a bound PV with claimRef', () => {
    const pv: K8sPv = {
      metadata: { name: 'pv-001', creationTimestamp: '2026-04-22T10:00:00Z', labels: { env: 'prod' } },
      spec: {
        capacity: { storage: '10Gi' },
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Delete',
        storageClassName: 'local-path',
        volumeMode: 'Filesystem',
        claimRef: { namespace: 'default', name: 'data-pvc' },
        csi: { driver: 'rancher.io/local-path' },
      },
      status: { phase: 'Bound' },
    };
    const out = mapPv(pv);
    assert.ok(out);
    assert.equal(out!.name, 'pv-001');
    assert.equal(out!.phase, 'Bound');
    assert.equal(out!.capacityBytes, 10 * 1024 ** 3);
    assert.deepEqual(out!.accessModes, ['ReadWriteOnce']);
    assert.equal(out!.reclaimPolicy, 'Delete');
    assert.equal(out!.storageClass, 'local-path');
    assert.equal(out!.volumeMode, 'Filesystem');
    assert.deepEqual(out!.claimRef, { namespace: 'default', name: 'data-pvc' });
    assert.equal(out!.csiDriver, 'rancher.io/local-path');
    assert.deepEqual(out!.labels, { env: 'prod' });
  });

  it('returns null when metadata.name is missing', () => {
    assert.equal(mapPv({ metadata: {} } as K8sPv), null);
  });

  it('tolerates unbound PV (no claimRef) and missing capacity', () => {
    const pv: K8sPv = {
      metadata: { name: 'pv-empty' },
      spec: {},
      status: { phase: 'Available' },
    };
    const out = mapPv(pv);
    assert.ok(out);
    assert.equal(out!.claimRef, null);
    assert.equal(out!.capacityBytes, null);
    assert.deepEqual(out!.accessModes, []);
  });

  it('flags orphan candidate via phase === Released', () => {
    const out = mapPv({
      metadata: { name: 'pv-orphan' },
      spec: { capacity: { storage: '1Gi' } },
      status: { phase: 'Released' },
    });
    assert.equal(out!.phase, 'Released');
  });
});

describe('mapPvc', () => {
  it('maps a bound PVC', () => {
    const pvc: K8sPvc = {
      metadata: { namespace: 'default', name: 'data-pvc', creationTimestamp: '2026-04-22T10:00:00Z' },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
        storageClassName: 'local-path',
        volumeName: 'pv-001',
        volumeMode: 'Filesystem',
      },
      status: { phase: 'Bound', capacity: { storage: '10Gi' } },
    };
    const out = mapPvc(pvc);
    assert.ok(out);
    assert.equal(out!.namespace, 'default');
    assert.equal(out!.name, 'data-pvc');
    assert.equal(out!.phase, 'Bound');
    assert.equal(out!.requestBytes, 5 * 1024 ** 3);
    assert.equal(out!.capacityBytes, 10 * 1024 ** 3);
    assert.equal(out!.volumeName, 'pv-001');
  });

  it('returns null when namespace or name missing', () => {
    assert.equal(mapPvc({ metadata: { name: 'x' } } as K8sPvc), null);
    assert.equal(mapPvc({ metadata: { namespace: 'ns' } } as K8sPvc), null);
  });

  it('handles pending (unbound) PVC', () => {
    const out = mapPvc({
      metadata: { namespace: 'default', name: 'pending-pvc' },
      spec: { resources: { requests: { storage: '1Gi' } } },
      status: { phase: 'Pending' },
    });
    assert.equal(out!.phase, 'Pending');
    assert.equal(out!.volumeName, null);
    assert.equal(out!.capacityBytes, null);
  });
});

describe('mapEvent', () => {
  it('maps a Warning pod event with legacy firstTimestamp/lastTimestamp', () => {
    const ev: K8sEvent = {
      metadata: { uid: 'evt-uid-1', creationTimestamp: '2026-04-23T10:00:00Z' },
      involvedObject: { kind: 'Pod', namespace: 'default', name: 'web-7d9-abc', uid: 'pod-uid' },
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      type: 'Warning',
      count: 5,
      firstTimestamp: '2026-04-23T09:55:00Z',
      lastTimestamp: '2026-04-23T10:00:30Z',
    };
    const out = mapEvent(ev);
    assert.ok(out);
    assert.equal(out!.eventUid, 'evt-uid-1');
    assert.equal(out!.namespace, 'default');
    assert.equal(out!.involvedKind, 'Pod');
    assert.equal(out!.involvedName, 'web-7d9-abc');
    assert.equal(out!.reason, 'BackOff');
    assert.equal(out!.type, 'Warning');
    assert.equal(out!.count, 5);
    assert.equal(out!.firstSeenAt, '2026-04-23T09:55:00Z');
    assert.equal(out!.lastSeenAt, '2026-04-23T10:00:30Z');
  });

  it('falls back to eventTime when firstTimestamp/lastTimestamp are null (new events.k8s.io API)', () => {
    const ev: K8sEvent = {
      metadata: { uid: 'evt-uid-2', creationTimestamp: '2026-04-23T10:00:00Z' },
      involvedObject: { kind: 'Node', name: 'k3d-node-0' },
      reason: 'MemoryPressure',
      message: 'Node is under memory pressure',
      type: 'Warning',
      firstTimestamp: null,
      lastTimestamp: null,
      eventTime: '2026-04-23T09:58:00Z',
    };
    const out = mapEvent(ev);
    assert.ok(out);
    assert.equal(out!.firstSeenAt, '2026-04-23T09:58:00Z');
    assert.equal(out!.lastSeenAt, '2026-04-23T09:58:00Z');
  });

  it('defaults count to 1 when not provided', () => {
    const out = mapEvent({
      metadata: { uid: 'evt-uid-3', creationTimestamp: '2026-04-23T10:00:00Z' },
      involvedObject: { kind: 'Pod', name: 'one-off', namespace: 'default' },
      reason: 'FailedScheduling',
      type: 'Warning',
    });
    assert.equal(out!.count, 1);
  });

  it('handles cluster-scoped events (no namespace)', () => {
    const out = mapEvent({
      metadata: { uid: 'evt-uid-4', creationTimestamp: '2026-04-23T10:00:00Z' },
      involvedObject: { kind: 'Node', name: 'k3d-node-0' },
      reason: 'NodeNotReady',
      type: 'Warning',
    });
    assert.equal(out!.namespace, null);
    assert.equal(out!.involvedKind, 'Node');
  });

  it('returns null when required fields are missing', () => {
    assert.equal(mapEvent({ metadata: {}, involvedObject: { kind: 'Pod', name: 'x' }, reason: 'X', type: 'Warning' }), null, 'missing uid');
    assert.equal(mapEvent({ metadata: { uid: 'u' }, involvedObject: { name: 'x' }, reason: 'X', type: 'Warning' }), null, 'missing kind');
    assert.equal(mapEvent({ metadata: { uid: 'u' }, involvedObject: { kind: 'Pod' }, reason: 'X', type: 'Warning' }), null, 'missing name');
    assert.equal(mapEvent({ metadata: { uid: 'u' }, involvedObject: { kind: 'Pod', name: 'x' }, type: 'Warning' }), null, 'missing reason');
    assert.equal(mapEvent({ metadata: { uid: 'u' }, involvedObject: { kind: 'Pod', name: 'x' }, reason: 'X' }), null, 'missing type');
  });
});
