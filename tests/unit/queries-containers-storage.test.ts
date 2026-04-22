import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getContainersStorage } = require('../../hub/src/web/queries');

function seedHost(db: any, hostId: string, lastSeen: string, group?: string) {
  db.prepare(
    `INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen, host_group)
     VALUES (?, datetime(?), datetime(?), ?)`
  ).run(hostId, lastSeen, lastSeen, group ?? null);
}

function seedUpdateCheck(db: any, hostId: string, name: string, image: string, at: string) {
  db.prepare(
    `INSERT INTO update_checks (host_id, container_name, image, local_digest, remote_digest, has_update, checked_at)
     VALUES (?, ?, ?, NULL, NULL, 0, ?)`
  ).run(hostId, name, image, at);
}

const recent = ts(new Date(NOW - 2 * 60 * 1000));
const older  = ts(new Date(NOW - 60 * 60 * 1000));

describe('getContainersStorage', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty totals when no containers exist', () => {
    const res = getContainersStorage(db, 10, false);
    assert.equal(res.totals.containerCount, 0);
    assert.equal(res.totals.totalRwBytes, 0);
    assert.deepEqual(res.hosts, []);
  });

  it('aggregates totals and groups containers by host', () => {
    seedHost(db, 'alpha', recent, 'prod');
    seedHost(db, 'beta', recent);
    seedContainerSnapshots(db, [
      { hostId: 'alpha', name: 'nginx',      sizeRwBytes: 100, sizeRootfsBytes: 1000, at: recent },
      { hostId: 'alpha', name: 'postgres',   sizeRwBytes: 500, sizeRootfsBytes: 2000, at: recent },
      { hostId: 'beta',  name: 'prometheus', sizeRwBytes: 300, sizeRootfsBytes: 1500, at: recent },
    ]);
    seedUpdateCheck(db, 'alpha', 'nginx', 'nginx:alpine', recent);

    const res = getContainersStorage(db, 10, false);

    assert.equal(res.totals.containerCount, 3);
    assert.equal(res.totals.totalRwBytes, 900);
    assert.equal(res.totals.totalRootfsBytes, 4500);

    const alpha = res.hosts.find((h: any) => h.hostId === 'alpha');
    assert.equal(alpha.containers.length, 2);
    assert.equal(alpha.hostGroup, 'prod');
    // Sorted by size_rw_bytes DESC — postgres (500) first.
    assert.equal(alpha.containers[0].name, 'postgres');
    assert.equal(alpha.containers[1].name, 'nginx');
    assert.equal(alpha.containers[1].image, 'nginx:alpine');
  });

  it('uses the latest non-null size even when the newest snapshot lacks sizes', () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      // Older snapshot has sizes
      { hostId: 'h1', name: 'app', sizeRwBytes: 200, sizeRootfsBytes: 800, at: older },
      // Newest snapshot: sizes null (e.g. size:true call failed this cycle)
      { hostId: 'h1', name: 'app', sizeRwBytes: null, sizeRootfsBytes: null, at: recent },
    ]);

    const res = getContainersStorage(db, 10, false);
    const c = res.hosts[0].containers[0];
    assert.equal(c.sizeRwBytes, 200);
    assert.equal(c.sizeRootfsBytes, 800);
  });

  it('includes containers that have never had size collected (with null sizes)', () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'legacy', sizeRwBytes: null, sizeRootfsBytes: null, at: recent },
    ]);

    const res = getContainersStorage(db, 10, false);
    assert.equal(res.hosts[0].containers.length, 1);
    assert.equal(res.hosts[0].containers[0].sizeRwBytes, null);
    assert.equal(res.totals.totalRwBytes, 0);
  });

  it('excludes insightd-internal containers by default and includes them with showInternal', () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'insightd-hub', labels: JSON.stringify({ 'insightd.internal': 'true' }), sizeRwBytes: 50, at: recent },
      { hostId: 'h1', name: 'nginx', sizeRwBytes: 100, at: recent },
    ]);

    const hidden = getContainersStorage(db, 10, false);
    assert.equal(hidden.totals.containerCount, 1);
    assert.equal(hidden.hosts[0].containers[0].name, 'nginx');

    const shown = getContainersStorage(db, 10, true);
    assert.equal(shown.totals.containerCount, 2);
  });

  it('excludes removed containers', () => {
    seedHost(db, 'h1', recent);
    seedContainerSnapshots(db, [
      { hostId: 'h1', name: 'ghost', sizeRwBytes: 999, at: older, removed: true },
      { hostId: 'h1', name: 'alive', sizeRwBytes: 100, at: recent },
    ]);

    const res = getContainersStorage(db, 10, false);
    assert.equal(res.totals.containerCount, 1);
    assert.equal(res.hosts[0].containers[0].name, 'alive');
  });

  it('marks offline hosts as online:false', () => {
    const stale = ts(new Date(NOW - 120 * 60 * 1000));
    seedHost(db, 'offline', stale);
    seedContainerSnapshots(db, [
      { hostId: 'offline', name: 'app', sizeRwBytes: 100, at: stale },
    ]);

    const res = getContainersStorage(db, 10, false);
    assert.equal(res.hosts[0].online, false);
  });
});
