import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestIngresses } = require('../../hub/src/ingest');

interface IngressRow {
  id: number;
  namespace: string;
  name: string;
  hosts: string;
  paths: string;
  tls_hosts: string | null;
  observed_at: string;
  removed_at: string | null;
}

/** Real-world ingest cycles are 5 min apart. The implementation uses a JS
 *  millisecond timestamp for batchAt and stamps removed_at only on rows whose
 *  observed_at is *strictly less* than batchAt. In tests we call ingest back-
 *  to-back, so without a small wait the batches collide on the same ms. */
function tick(ms = 5): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function seedIng(ns: string, name: string, host: string, tls = false) {
  return {
    namespace: ns,
    name,
    hosts: [host],
    paths: [{ host, path: '/', pathType: 'Prefix', serviceName: name, servicePort: 80 }],
    tlsHosts: tls ? [host] : [],
    externalIp: null,
    createdAt: null,
    labels: {},
  };
}

describe('ingestIngresses', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('upserts on (cluster_id, namespace, name) — second batch updates in place', async () => {
    ingestIngresses(db, 'c1', [seedIng('default', 'app', 'app.local')]);
    await tick();
    ingestIngresses(db, 'c1', [seedIng('default', 'app', 'app.example.com', true)]);
    const rows = db.prepare('SELECT * FROM k8s_ingresses').all() as IngressRow[];
    assert.equal(rows.length, 1, 'no duplicate row on re-upsert');
    const hosts = JSON.parse(rows[0]!.hosts) as string[];
    const tlsHosts = JSON.parse(rows[0]!.tls_hosts ?? '[]') as string[];
    assert.deepEqual(hosts, ['app.example.com']);
    assert.deepEqual(tlsHosts, ['app.example.com']);
  });

  it('stamps removed_at on rows missing from a later batch', async () => {
    ingestIngresses(db, 'c1', [
      seedIng('default', 'a', 'a.local'),
      seedIng('default', 'b', 'b.local'),
    ]);
    await tick();
    // Batch 2 only has 'a' — 'b' should be marked removed
    ingestIngresses(db, 'c1', [seedIng('default', 'a', 'a.local')]);
    const a = db.prepare("SELECT removed_at FROM k8s_ingresses WHERE name = 'a'").get() as { removed_at: string | null };
    const b = db.prepare("SELECT removed_at FROM k8s_ingresses WHERE name = 'b'").get() as { removed_at: string | null };
    assert.equal(a.removed_at, null, 'present ingress is not stamped removed');
    assert.notEqual(b.removed_at, null, 'missing ingress gets removed_at stamp');
  });

  it('clears removed_at when a previously-removed ingress reappears', async () => {
    ingestIngresses(db, 'c1', [seedIng('default', 'a', 'a.local')]);
    await tick();
    ingestIngresses(db, 'c1', []); // 'a' now stale
    let a = db.prepare("SELECT removed_at FROM k8s_ingresses WHERE name = 'a'").get() as { removed_at: string | null };
    assert.notEqual(a.removed_at, null);
    await tick();
    ingestIngresses(db, 'c1', [seedIng('default', 'a', 'a.local')]);
    a = db.prepare("SELECT removed_at FROM k8s_ingresses WHERE name = 'a'").get() as { removed_at: string | null };
    assert.equal(a.removed_at, null, 'reappearance clears removed_at');
  });

  it('isolates clusters — c2 batch does not stamp c1 rows', async () => {
    ingestIngresses(db, 'c1', [seedIng('default', 'a', 'a.local')]);
    await tick();
    ingestIngresses(db, 'c2', [seedIng('default', 'b', 'b.local')]);
    const a = db.prepare("SELECT cluster_id, removed_at FROM k8s_ingresses WHERE name = 'a'").get() as { cluster_id: string; removed_at: string | null };
    assert.equal(a.cluster_id, 'c1');
    assert.equal(a.removed_at, null, 'cross-cluster batch must not affect other cluster');
  });
});
