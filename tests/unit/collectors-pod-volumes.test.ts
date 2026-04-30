import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPodVolumes } from '../../agent/src/collectors/k8s-cluster';
import type { K8sPod } from '../../agent/src/runtime/kubernetes';

function pod(volumes: any[], opts: { name?: string; namespace?: string; uid?: string } = {}): K8sPod {
  return {
    metadata: {
      name: opts.name ?? 'test-pod',
      namespace: opts.namespace ?? 'default',
      uid: opts.uid ?? 'uid-1',
    },
    spec: { volumes },
  };
}

describe('mapPodVolumes', () => {
  it('returns [] for pods without uid or namespace (un-keyable)', () => {
    assert.deepEqual(mapPodVolumes({ metadata: { name: 'p' }, spec: { volumes: [{ name: 'v', emptyDir: {} }] } }), []);
    assert.deepEqual(mapPodVolumes({ metadata: { uid: 'u' }, spec: { volumes: [{ name: 'v', emptyDir: {} }] } }), []);
  });

  it('classifies persistentVolumeClaim as pvc + captures claimName', () => {
    const out = mapPodVolumes(pod([{ name: 'data', persistentVolumeClaim: { claimName: 'mysql-data' } }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].volumeType, 'pvc');
    assert.equal(out[0].targetName, 'mysql-data');
    assert.equal(out[0].volumeName, 'data');
  });

  it('classifies configMap and secret', () => {
    const out = mapPodVolumes(pod([
      { name: 'cfg', configMap: { name: 'app-config' } },
      { name: 'tls', secret: { secretName: 'tls-cert' } },
    ]));
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map(v => ({ t: v.volumeType, n: v.targetName })).sort((a, b) => a.t.localeCompare(b.t)),
      [{ t: 'configMap', n: 'app-config' }, { t: 'secret', n: 'tls-cert' }],
    );
  });

  it('classifies ambient types and preserves the volume name', () => {
    const out = mapPodVolumes(pod([
      { name: 'tmp', emptyDir: {} },
      { name: 'host-logs', hostPath: { path: '/var/log' } },
      { name: 'sa-token', projected: { sources: [] } },
    ]));
    const byName = Object.fromEntries(out.map(v => [v.volumeName, v]));
    assert.equal(byName['tmp'].volumeType, 'emptyDir');
    assert.equal(byName['tmp'].targetName, null);
    assert.equal(byName['host-logs'].volumeType, 'hostPath');
    assert.equal(byName['host-logs'].targetName, '/var/log');
    assert.equal(byName['sa-token'].volumeType, 'projected');
  });

  it('falls through to "other" for unknown volume sources', () => {
    const out = mapPodVolumes(pod([{ name: 'csi-vol', csi: { driver: 'nfs.csi.k8s.io' } } as any]));
    assert.equal(out[0].volumeType, 'other');
    assert.equal(out[0].targetName, null);
  });

  it('skips volumes without a name', () => {
    const out = mapPodVolumes(pod([{ persistentVolumeClaim: { claimName: 'x' } } as any]));
    assert.deepEqual(out, []);
  });

  it('handles a pod with no volumes', () => {
    const out = mapPodVolumes({ metadata: { name: 'p', namespace: 'd', uid: 'u' }, spec: { volumes: undefined } });
    assert.deepEqual(out, []);
  });
});
