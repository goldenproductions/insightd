import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getVolumesOverview } = require('../../hub/src/web/queries');

function seedHost(db: any, hostId: string, lastSeen: string, runtimeType: string = 'docker', group?: string) {
  db.prepare(
    `INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group)
     VALUES (?, datetime(?), datetime(?), ?, ?)`
  ).run(hostId, lastSeen, lastSeen, runtimeType, group ?? null);
}

interface VolumeSeed {
  hostId: string; name: string; driver?: string; mountpoint?: string | null;
  sizeBytes?: number | null; refCount?: number | null; createdAt?: string | null;
  at: string;
}

function seedVolumes(db: any, rows: VolumeSeed[]) {
  const insert = db.prepare(`
    INSERT INTO volume_snapshots (host_id, volume_name, driver, mountpoint, size_bytes, ref_count, created_at, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  for (const r of rows) {
    insert.run(r.hostId, r.name, r.driver ?? 'local', r.mountpoint ?? null,
      r.sizeBytes ?? null, r.refCount ?? null, r.createdAt ?? null, r.at);
  }
}

const recent = ts(new Date(NOW - 2 * 60 * 1000));
const older  = ts(new Date(NOW - 60 * 60 * 1000));

describe('getVolumesOverview', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty totals and no hosts when nothing is seeded', () => {
    const res = getVolumesOverview(db, 10);
    assert.equal(res.totals.volumeCount, 0);
    assert.equal(res.totals.totalSizeBytes, 0);
    assert.equal(res.totals.orphanedCount, 0);
    assert.deepEqual(res.hosts, []);
  });

  it('aggregates totals and groups volumes by host', () => {
    seedHost(db, 'alpha', recent);
    seedHost(db, 'beta', recent);
    seedVolumes(db, [
      { hostId: 'alpha', name: 'pg_data',      sizeBytes: 500,  refCount: 1, at: recent },
      { hostId: 'alpha', name: 'redis_data',   sizeBytes: 100,  refCount: 1, at: recent },
      { hostId: 'beta',  name: 'grafana',      sizeBytes: 300,  refCount: 1, at: recent },
    ]);

    const res = getVolumesOverview(db, 10);
    assert.equal(res.totals.volumeCount, 3);
    assert.equal(res.totals.totalSizeBytes, 900);
    assert.equal(res.totals.orphanedCount, 0);
    assert.equal(res.hosts.length, 2);

    const alpha = res.hosts.find((h: any) => h.hostId === 'alpha');
    assert.equal(alpha.volumes.length, 2);
    // Sorted by size DESC
    assert.equal(alpha.volumes[0].name, 'pg_data');
    assert.equal(alpha.volumes[0].sizeBytes, 500);
  });

  it('counts orphaned volumes (refCount === 0) separately', () => {
    seedHost(db, 'h1', recent);
    seedVolumes(db, [
      { hostId: 'h1', name: 'active',   sizeBytes: 100, refCount: 2, at: recent },
      { hostId: 'h1', name: 'orphan_a', sizeBytes: 200, refCount: 0, at: recent },
      { hostId: 'h1', name: 'orphan_b', sizeBytes: 400, refCount: 0, at: recent },
      { hostId: 'h1', name: 'unknown',  sizeBytes: 50,  refCount: null, at: recent },
    ]);

    const res = getVolumesOverview(db, 10);
    assert.equal(res.totals.volumeCount, 4);
    assert.equal(res.totals.orphanedCount, 2);
    assert.equal(res.totals.orphanedSizeBytes, 600);
  });

  it('only uses the latest batch per host — older snapshots are ignored', () => {
    seedHost(db, 'h1', recent);
    seedVolumes(db, [
      { hostId: 'h1', name: 'old_vol',     sizeBytes: 999, refCount: 1, at: older },
      { hostId: 'h1', name: 'current_vol', sizeBytes: 100, refCount: 1, at: recent },
    ]);

    const res = getVolumesOverview(db, 10);
    assert.equal(res.totals.volumeCount, 1);
    assert.equal(res.hosts[0].volumes[0].name, 'current_vol');
    assert.equal(res.totals.totalSizeBytes, 100);
  });

  it('includes hosts with no volume data (so UI can render placeholders for k8s)', () => {
    seedHost(db, 'k8s-node-1', recent, 'kubernetes');
    seedHost(db, 'docker-host', recent, 'docker');
    seedVolumes(db, [
      { hostId: 'docker-host', name: 'pg', sizeBytes: 100, refCount: 1, at: recent },
    ]);

    const res = getVolumesOverview(db, 10);
    assert.equal(res.hosts.length, 2);
    const k8s = res.hosts.find((h: any) => h.hostId === 'k8s-node-1');
    assert.equal(k8s.runtimeType, 'kubernetes');
    assert.deepEqual(k8s.volumes, []);
    const docker = res.hosts.find((h: any) => h.hostId === 'docker-host');
    assert.equal(docker.runtimeType, 'docker');
    assert.equal(docker.volumes.length, 1);
  });
});
