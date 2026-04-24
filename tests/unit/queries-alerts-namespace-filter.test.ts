import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedAlertState } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getAlertsExplore } = require('../../hub/src/web/queries');

const recent = ts(new Date(NOW - 2 * 60 * 1000));

describe('getAlertsExplore — namespace filter', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  function seedMixed() {
    seedAlertState(db, [
      { hostId: 'proxmox-01', type: 'container_down', target: 'nginx',                                    triggeredAt: recent },
      { hostId: 'proxmox-01', type: 'high_cpu',       target: 'redis',                                    triggeredAt: recent },
      { hostId: 'k3s-node',   type: 'container_down', target: 'kube-system/coredns-abc/coredns',          triggeredAt: recent },
      { hostId: 'k3s-node',   type: 'high_cpu',       target: 'kube-system/metrics-xyz/metrics',          triggeredAt: recent },
      { hostId: 'k3s-node',   type: 'container_down', target: 'default/myapp-xyz/myapp',                  triggeredAt: recent },
      { hostId: 'k3s-node',   type: 'host_offline',   target: 'k3s-node',                                 triggeredAt: recent },
    ]);
  }

  it('filters to a single namespace, excluding Docker and host-scoped alerts', () => {
    seedMixed();
    const res = getAlertsExplore(db, { limit: 50, offset: 0, namespaces: ['kube-system'] });
    assert.equal(res.total, 2);
    for (const a of res.alerts) {
      assert.ok(a.target.startsWith('kube-system/'), `unexpected target: ${a.target}`);
    }
  });

  it('supports multiple namespaces (OR)', () => {
    seedMixed();
    const res = getAlertsExplore(db, { limit: 50, offset: 0, namespaces: ['kube-system', 'default'] });
    assert.equal(res.total, 3);
  });

  it('byNamespace facet excludes Docker + host-scoped targets and sorts by count desc', () => {
    seedMixed();
    const res = getAlertsExplore(db, { limit: 50, offset: 0 });
    const names = res.counts.byNamespace.map((n: { namespace: string }) => n.namespace);
    assert.deepEqual(names, ['kube-system', 'default']);
    assert.equal(res.counts.byNamespace[0]!.count, 2);
    assert.equal(res.counts.byNamespace[1]!.count, 1);
  });

  it('byNamespace respects other active filters (filtered counts)', () => {
    // Two hosts, both have kube-system. Filter by one host — byNamespace
    // should drop the other host's kube-system alerts out of the count.
    seedAlertState(db, [
      { hostId: 'cluster-a', type: 'container_down', target: 'kube-system/a/a', triggeredAt: recent },
      { hostId: 'cluster-a', type: 'container_down', target: 'kube-system/b/b', triggeredAt: recent },
      { hostId: 'cluster-b', type: 'container_down', target: 'kube-system/c/c', triggeredAt: recent },
    ]);
    const res = getAlertsExplore(db, { limit: 50, offset: 0, hosts: ['cluster-a'] });
    const ks = res.counts.byNamespace.find((n: { namespace: string }) => n.namespace === 'kube-system');
    assert.equal(ks?.count, 2, 'byNamespace should only count alerts on filtered host');
  });

  it('byNamespace does NOT collapse to zero when namespace filter is active (excludes own filter)', () => {
    seedMixed();
    const res = getAlertsExplore(db, { limit: 50, offset: 0, namespaces: ['kube-system'] });
    const ks = res.counts.byNamespace.find((n: { namespace: string }) => n.namespace === 'kube-system');
    assert.equal(ks?.count, 2);
    const def = res.counts.byNamespace.find((n: { namespace: string }) => n.namespace === 'default');
    assert.equal(def?.count, 1, 'other namespaces stay visible so user can switch selection');
  });

  it('excludes disk_full alerts whose target is a mount path like "/" or "/mnt/x"', () => {
    // disk_full alerts use the mount point as target. A leading-slash target
    // must NOT produce an empty-string namespace in the facet.
    seedAlertState(db, [
      { hostId: 'h1', type: 'disk_full', target: '/',       triggeredAt: recent },
      { hostId: 'h1', type: 'disk_full', target: '/mnt/zfs', triggeredAt: recent },
      { hostId: 'h1', type: 'container_down', target: 'kube-system/x/y', triggeredAt: recent },
    ]);
    const res = getAlertsExplore(db, { limit: 50, offset: 0 });
    const names = res.counts.byNamespace.map((n: { namespace: string }) => n.namespace);
    assert.deepEqual(names, ['kube-system'], 'mount-path targets must not contribute to namespace facet');
  });

  it('Docker-only fleet yields empty byNamespace facet', () => {
    seedAlertState(db, [
      { hostId: 'docker-host', type: 'container_down', target: 'nginx', triggeredAt: recent },
      { hostId: 'docker-host', type: 'high_cpu',       target: 'redis', triggeredAt: recent },
    ]);
    const res = getAlertsExplore(db, { limit: 50, offset: 0 });
    assert.deepEqual(res.counts.byNamespace, []);
  });
});
