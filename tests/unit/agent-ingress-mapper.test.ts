import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { mapIngress } = require('../../agent/src/collectors/k8s-cluster');

describe('mapIngress', () => {
  it('maps a typical single-host ingress with a / path', () => {
    const out = mapIngress({
      metadata: { name: 'grafana', namespace: 'monitoring', creationTimestamp: '2026-04-01T00:00:00Z' },
      spec: {
        ingressClassName: 'traefik',
        rules: [{
          host: 'grafana.local.example',
          http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'grafana', port: { number: 80 } } } }] },
        }],
      },
    });
    assert.equal(out!.namespace, 'monitoring');
    assert.equal(out!.name, 'grafana');
    assert.equal(out!.ingressClass, 'traefik');
    assert.deepEqual(out!.hosts, ['grafana.local.example']);
    assert.equal(out!.paths.length, 1);
    assert.equal(out!.paths[0]!.path, '/');
    assert.equal(out!.paths[0]!.serviceName, 'grafana');
    assert.equal(out!.paths[0]!.servicePort, 80);
    assert.deepEqual(out!.tlsHosts, []);
  });

  it('extracts tls hosts from spec.tls[]', () => {
    const out = mapIngress({
      metadata: { name: 'app', namespace: 'default' },
      spec: {
        rules: [{ host: 'app.example.com', http: { paths: [{ path: '/' }] } }],
        tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }],
      },
    });
    assert.deepEqual(out!.tlsHosts, ['app.example.com']);
  });

  it('flattens multi-path rules', () => {
    const out = mapIngress({
      metadata: { name: 'multi', namespace: 'default' },
      spec: {
        rules: [{
          host: 'h1.local',
          http: { paths: [
            { path: '/api',  pathType: 'Prefix', backend: { service: { name: 'api',  port: { number: 8080 } } } },
            { path: '/web',  pathType: 'Prefix', backend: { service: { name: 'web',  port: { number: 80   } } } },
          ] },
        }],
      },
    });
    assert.equal(out!.paths.length, 2);
    assert.equal(out!.paths[0]!.path, '/api');
    assert.equal(out!.paths[1]!.path, '/web');
  });

  it('returns null when no rule has a host (not actionable as a URL)', () => {
    const out = mapIngress({
      metadata: { name: 'hostless', namespace: 'default' },
      spec: { rules: [{ http: { paths: [{ path: '/' }] } }] },
    });
    assert.equal(out, null);
  });

  it('returns null when metadata.name or namespace is missing', () => {
    assert.equal(mapIngress({ metadata: { namespace: 'default' }, spec: { rules: [{ host: 'h' }] } }), null);
    assert.equal(mapIngress({ metadata: { name: 'x' }, spec: { rules: [{ host: 'h' }] } }), null);
  });

  it('captures externalIp / hostname from status.loadBalancer when present', () => {
    const out = mapIngress({
      metadata: { name: 'ext', namespace: 'default' },
      spec: { rules: [{ host: 'h.local', http: { paths: [{ path: '/' }] } }] },
      status: { loadBalancer: { ingress: [{ ip: '10.0.0.1' }] } },
    });
    assert.equal(out!.externalIp, '10.0.0.1');
  });
});
