import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPv, mapPvc } from '../../agent/src/collectors/k8s-cluster';
import type { K8sPv, K8sPvc } from '../../agent/src/runtime/kubernetes';

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
