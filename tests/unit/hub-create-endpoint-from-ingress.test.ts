import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestIngresses } = require('../../hub/src/ingest');
const { createEndpointFromIngress, getDiscoveredIngresses, dismissIngress, undismissIngress } = require('../../hub/src/http-monitor/queries');

function seedIng(opts: { namespace: string; name: string; host: string; tls?: boolean; pathOverride?: string | null }) {
  const path = opts.pathOverride ?? '/';
  return {
    namespace: opts.namespace,
    name: opts.name,
    hosts: [opts.host],
    paths: [{ host: opts.host, path, pathType: 'Prefix', serviceName: opts.name, servicePort: 80 }],
    tlsHosts: opts.tls ? [opts.host] : [],
    externalIp: null,
    createdAt: null,
    labels: {},
  };
}

function getIngressId(db: any, ns: string, name: string): number {
  const row = db.prepare('SELECT id FROM k8s_ingresses WHERE namespace = ? AND name = ?').get(ns, name) as { id: number };
  return row.id;
}

describe('createEndpointFromIngress', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates an https endpoint when host appears in tlsHosts', () => {
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'monitoring', name: 'grafana', host: 'grafana.local', tls: true })]);
    const id = getIngressId(db, 'monitoring', 'grafana');
    const created = createEndpointFromIngress(db, id);
    assert.equal(created.url, 'https://grafana.local');
    assert.equal(created.name, 'monitoring/grafana.local');
  });

  it('creates an http endpoint when host has no TLS', () => {
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'default', name: 'app', host: 'app.local' })]);
    const id = getIngressId(db, 'default', 'app');
    const created = createEndpointFromIngress(db, id);
    assert.equal(created.url, 'http://app.local');
  });

  it('appends the first non-/ path to the URL', () => {
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'default', name: 'api', host: 'api.local', pathOverride: '/v1' })]);
    const id = getIngressId(db, 'default', 'api');
    const created = createEndpointFromIngress(db, id);
    assert.equal(created.url, 'http://api.local/v1');
  });

  it('suffixes -2 on a duplicate name', () => {
    ingestIngresses(db, 'c1', [
      seedIng({ namespace: 'default', name: 'a', host: 'a.local' }),
      seedIng({ namespace: 'default', name: 'b', host: 'a.local' }),
    ]);
    const idA = getIngressId(db, 'default', 'a');
    const idB = getIngressId(db, 'default', 'b');
    createEndpointFromIngress(db, idA);
    const second = createEndpointFromIngress(db, idB);
    assert.equal(second.name, 'default/a.local-2');
  });

  it('rejects with ALREADY_MONITORED when the same ingress is promoted twice', () => {
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'default', name: 'a', host: 'a.local' })]);
    const id = getIngressId(db, 'default', 'a');
    const first = createEndpointFromIngress(db, id);
    assert.throws(
      () => createEndpointFromIngress(db, id),
      (e: any) => e.code === 'ALREADY_MONITORED' && e.endpointId === Number(first.id),
    );
  });

  it('rejects with NOT_FOUND for an unknown ingress id', () => {
    assert.throws(
      () => createEndpointFromIngress(db, 999),
      (e: any) => e.code === 'NOT_FOUND',
    );
  });

  it('persists source_ingress_id on the created endpoint', () => {
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'default', name: 'x', host: 'x.local' })]);
    const id = getIngressId(db, 'default', 'x');
    const created = createEndpointFromIngress(db, id);
    const row = db.prepare('SELECT source_ingress_id FROM http_endpoints WHERE id = ?').get(Number(created.id)) as { source_ingress_id: number };
    assert.equal(row.source_ingress_id, id);
  });
});

describe('getDiscoveredIngresses', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('hides ingresses that have been promoted to monitored endpoints', async () => {
    ingestIngresses(db, 'c1', [
      seedIng({ namespace: 'default', name: 'a', host: 'a.local' }),
      seedIng({ namespace: 'default', name: 'b', host: 'b.local' }),
    ]);
    let list = getDiscoveredIngresses(db);
    assert.equal(list.length, 2, 'both visible before promotion');

    const idA = getIngressId(db, 'default', 'a');
    createEndpointFromIngress(db, idA);
    list = getDiscoveredIngresses(db);
    assert.equal(list.length, 1, 'monitored ingress drops off the discovered list');
    assert.equal(list[0].name, 'b');
  });

  it('hides ingresses that have been dismissed; un-dismissing brings them back', () => {
    ingestIngresses(db, 'c1', [
      seedIng({ namespace: 'default', name: 'a', host: 'a.local' }),
      seedIng({ namespace: 'default', name: 'b', host: 'b.local' }),
    ]);
    const idA = getIngressId(db, 'default', 'a');
    const r = dismissIngress(db, idA);
    assert.equal(r.dismissed, true);

    let list = getDiscoveredIngresses(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'b');

    // Undismiss restores the row.
    const u = undismissIngress(db, idA);
    assert.equal(u.undismissed, true);
    list = getDiscoveredIngresses(db);
    assert.equal(list.length, 2);
  });

  it('hides ingresses that have been removed from the cluster', async () => {
    ingestIngresses(db, 'c1', [
      seedIng({ namespace: 'default', name: 'a', host: 'a.local' }),
      seedIng({ namespace: 'default', name: 'b', host: 'b.local' }),
    ]);
    await new Promise(r => setTimeout(r, 5));
    ingestIngresses(db, 'c1', [seedIng({ namespace: 'default', name: 'a', host: 'a.local' })]);
    const list = getDiscoveredIngresses(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'a');
  });

  it('dismissIngress on an unknown id is a no-op', () => {
    const r = dismissIngress(db, 999);
    assert.equal(r.dismissed, false);
  });
});
