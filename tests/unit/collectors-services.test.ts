import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapService } from '../../agent/src/collectors/k8s-cluster';
import type { K8sService } from '../../agent/src/runtime/kubernetes';

describe('mapService', () => {
  it('maps a ClusterIP service with selector and ports', () => {
    const svc: K8sService = {
      metadata: { name: 'web', namespace: 'default', creationTimestamp: '2026-04-22T10:00:00Z', labels: { tier: 'frontend' } },
      spec: {
        type: 'ClusterIP',
        clusterIP: '10.43.1.2',
        selector: { app: 'web' },
        ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
      },
    };
    const out = mapService(svc);
    assert.ok(out);
    assert.equal(out!.namespace, 'default');
    assert.equal(out!.name, 'web');
    assert.equal(out!.type, 'ClusterIP');
    assert.equal(out!.clusterIp, '10.43.1.2');
    assert.deepEqual(out!.selector, { app: 'web' });
    assert.equal(out!.ports.length, 1);
    assert.equal(out!.ports[0].port, 80);
    assert.equal(out!.ports[0].targetPort, 8080);
    assert.equal(out!.ports[0].protocol, 'TCP');
  });

  it('defaults missing type to ClusterIP', () => {
    const out = mapService({ metadata: { name: 'svc', namespace: 'default' }, spec: { ports: [{ port: 80 }] } });
    assert.equal(out!.type, 'ClusterIP');
  });

  it('captures externalName for type=ExternalName services', () => {
    const out = mapService({
      metadata: { name: 'db', namespace: 'default' },
      spec: { type: 'ExternalName', externalName: 'mysql.example.com', ports: [] },
    });
    assert.equal(out!.type, 'ExternalName');
    assert.equal(out!.externalName, 'mysql.example.com');
    assert.equal(out!.selector, null);
  });

  it('preserves a null selector vs an empty selector', () => {
    const noSel = mapService({ metadata: { name: 'a', namespace: 'd' }, spec: { ports: [] } });
    assert.equal(noSel!.selector, null);
    const empty = mapService({ metadata: { name: 'b', namespace: 'd' }, spec: { selector: {}, ports: [] } });
    assert.deepEqual(empty!.selector, {});
  });

  it('captures NodePort + nodePort number', () => {
    const out = mapService({
      metadata: { name: 'lb', namespace: 'default' },
      spec: { type: 'NodePort', selector: { app: 'lb' }, ports: [{ port: 80, nodePort: 30080 }] },
    });
    assert.equal(out!.ports[0].nodePort, 30080);
  });

  it('returns null when metadata.name or namespace is missing', () => {
    assert.equal(mapService({ metadata: { name: 'x' }, spec: {} } as K8sService), null);
    assert.equal(mapService({ metadata: { namespace: 'd' }, spec: {} } as K8sService), null);
  });
});
