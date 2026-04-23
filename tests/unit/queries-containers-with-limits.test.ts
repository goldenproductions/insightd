import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { getLatestContainers, getLatestContainer } = require('../../hub/src/web/queries');

function ts(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

describe('getLatestContainers — k8s resource limits (v36)', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null limit fields for containers without limits (Docker parity)', () => {
    seedContainerSnapshots(db, [
      { name: 'docker-app', status: 'running', mem: 800, at: ts(new Date()) },
    ]);
    db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('local', ?, ?)").run(ts(new Date()), ts(new Date()));

    const rows = getLatestContainers(db, 'local', 15, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu_limit_cores, null);
    assert.equal(rows[0].cpu_limit_percent, null);
    assert.equal(rows[0].memory_limit_mb, null);
    assert.equal(rows[0].memory_limit_percent, null);
  });

  it('surfaces cpu/memory limits and derives memory_limit_percent when set', () => {
    const now = ts(new Date());
    seedContainerSnapshots(db, [
      { name: 'memtest', status: 'running', cpu: 20, mem: 120, at: now },
    ]);
    db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('local', ?, ?)").run(now, now);
    // Attach limits via UPDATE since seedContainerSnapshots predates v36.
    db.prepare(`
      UPDATE container_snapshots
      SET cpu_limit_cores = 0.5, cpu_limit_percent = 82.5, memory_limit_mb = 128
      WHERE container_name = 'memtest'
    `).run();

    const rows = getLatestContainers(db, 'local', 15, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpu_limit_cores, 0.5);
    assert.equal(rows[0].cpu_limit_percent, 82.5);
    assert.equal(rows[0].memory_limit_mb, 128);
    // 120 / 128 = 93.75
    assert.equal(rows[0].memory_limit_percent, 93.8);
  });

  it('memory_limit_percent is null when memory_limit_mb is zero (avoids div-by-zero)', () => {
    const now = ts(new Date());
    seedContainerSnapshots(db, [
      { name: 'edge', status: 'running', mem: 50, at: now },
    ]);
    db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('local', ?, ?)").run(now, now);
    db.prepare(`UPDATE container_snapshots SET memory_limit_mb = 0 WHERE container_name = 'edge'`).run();

    const rows = getLatestContainers(db, 'local', 15, true);
    assert.equal(rows[0].memory_limit_percent, null);
  });
});

describe('getLatestContainer — k8s resource limits (v36)', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('includes limit fields on the single-container response', () => {
    const now = ts(new Date());
    seedContainerSnapshots(db, [
      { name: 'stress', status: 'running', cpu: 15, mem: 100, at: now },
    ]);
    db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('local', ?, ?)").run(now, now);
    db.prepare(`
      UPDATE container_snapshots
      SET cpu_limit_cores = 1, cpu_limit_percent = 45, memory_limit_mb = 200
      WHERE container_name = 'stress'
    `).run();

    const row = getLatestContainer(db, 'local', 'stress', 15);
    assert.ok(row);
    assert.equal(row.cpu_limit_cores, 1);
    assert.equal(row.cpu_limit_percent, 45);
    assert.equal(row.memory_limit_mb, 200);
    assert.equal(row.memory_limit_percent, 50);
  });
});
