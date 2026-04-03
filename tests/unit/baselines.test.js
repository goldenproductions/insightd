const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedHostSnapshots, seedContainerSnapshots } = require('../helpers/db');
const { ts, NOW, THIS_WEEK } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const { computeBaselines, percentile, getTimePeriod, TIME_PERIODS } = require('../../hub/src/insights/baselines');

describe('baselines', () => {
  let db, restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  describe('percentile', () => {
    it('should compute P50 (median)', () => {
      assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
    });

    it('should compute P95', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      assert.equal(percentile(values, 95), 95.05);
    });

    it('should return null for empty array', () => {
      assert.equal(percentile([], 50), null);
    });

    it('should handle single value', () => {
      assert.equal(percentile([42], 50), 42);
      assert.equal(percentile([42], 99), 42);
    });
  });

  describe('computeBaselines', () => {
    it('should compute host baselines from snapshots', () => {
      // Seed 10 host snapshots with varying CPU
      for (let i = 0; i < 10; i++) {
        seedHostSnapshots(db, [{
          hostId: 'test-host', cpu: 10 + i * 5, memTotal: 8000, memUsed: 4000, memAvail: 4000,
          load1: 1 + i * 0.1, at: ts(new Date(NOW - i * 300000)),
        }]);
      }

      computeBaselines(db);

      const baselines = db.prepare("SELECT * FROM baselines WHERE entity_type = 'host' AND entity_id = 'test-host' AND time_bucket = 'all'").all();
      assert.ok(baselines.length > 0);

      const cpuBaseline = baselines.find(b => b.metric === 'cpu_percent');
      assert.ok(cpuBaseline);
      assert.ok(cpuBaseline.p50 > 0);
      assert.ok(cpuBaseline.p95 > cpuBaseline.p50);
      assert.equal(cpuBaseline.sample_count, 10);
    });

    it('should compute container baselines', () => {
      for (let i = 0; i < 10; i++) {
        seedContainerSnapshots(db, [{
          name: 'nginx', status: 'running', cpu: 5 + i * 2, mem: 50 + i * 10,
          at: ts(new Date(NOW - i * 300000)),
        }]);
      }

      computeBaselines(db);

      const baselines = db.prepare("SELECT * FROM baselines WHERE entity_type = 'container' AND entity_id = 'local/nginx' AND time_bucket = 'all'").all();
      assert.ok(baselines.length > 0);

      const cpuBaseline = baselines.find(b => b.metric === 'cpu_percent');
      assert.ok(cpuBaseline);
      assert.equal(cpuBaseline.sample_count, 10);
    });

    it('should skip non-running container snapshots', () => {
      seedContainerSnapshots(db, [
        { name: 'nginx', status: 'running', cpu: 10, mem: 50, at: ts(NOW) },
        { name: 'nginx', status: 'exited', cpu: 0, mem: 0, at: ts(THIS_WEEK) },
      ]);

      computeBaselines(db);

      const cpuBaseline = db.prepare("SELECT * FROM baselines WHERE entity_id = 'local/nginx' AND metric = 'cpu_percent' AND time_bucket = 'all'").get();
      assert.equal(cpuBaseline.sample_count, 1); // Only the running snapshot
    });

    it('should handle empty database gracefully', () => {
      computeBaselines(db); // Should not throw
      const count = db.prepare('SELECT COUNT(*) as c FROM baselines').get();
      assert.equal(count.c, 0);
    });

    it('should update baselines on re-run (UPSERT)', () => {
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 50, memTotal: 8000, memUsed: 4000, memAvail: 4000, load1: 1, at: ts(NOW) }]);
      computeBaselines(db);

      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 80, memTotal: 8000, memUsed: 6000, memAvail: 2000, load1: 2, at: ts(new Date(NOW - 300000)) }]);
      computeBaselines(db);

      const cpuBaseline = db.prepare("SELECT * FROM baselines WHERE entity_id = 'h1' AND metric = 'cpu_percent' AND time_bucket = 'all'").get();
      assert.equal(cpuBaseline.sample_count, 2);
    });

    it('should compute time-period baselines when enough samples', () => {
      // Seed 60 snapshots at 10am (morning period) within the last 30 days
      for (let i = 0; i < 60; i++) {
        const d = new Date(NOW - (i * 12) * 60 * 60 * 1000); // every 12 hours, stays within 30 days
        d.setUTCHours(10, 0, 0, 0);
        seedHostSnapshots(db, [{ hostId: 'h1', cpu: 20 + (i % 30), memTotal: 8000, memUsed: 4000, memAvail: 4000, load1: 1, at: ts(d) }]);
      }
      computeBaselines(db);

      const morningBaseline = db.prepare("SELECT * FROM baselines WHERE entity_id = 'h1' AND metric = 'cpu_percent' AND time_bucket = 'morning'").get();
      assert.ok(morningBaseline, 'Morning baseline should exist');
      assert.ok(morningBaseline.sample_count >= 48);
    });

    it('should not compute time-period baselines with insufficient samples', () => {
      // Seed only 10 snapshots at 3am (night period) — below threshold
      for (let i = 0; i < 10; i++) {
        const d = new Date(NOW - i * 86400000);
        d.setUTCHours(3, 0, 0, 0);
        seedHostSnapshots(db, [{ hostId: 'h1', cpu: 20 + i, memTotal: 8000, memUsed: 4000, memAvail: 4000, load1: 1, at: ts(d) }]);
      }
      computeBaselines(db);

      const nightBaseline = db.prepare("SELECT * FROM baselines WHERE entity_id = 'h1' AND metric = 'cpu_percent' AND time_bucket = 'night'").get();
      assert.equal(nightBaseline, undefined, 'Night baseline should not exist with insufficient samples');
    });
  });

  describe('getTimePeriod', () => {
    it('should return correct period for each hour', () => {
      assert.equal(getTimePeriod(0), 'night');
      assert.equal(getTimePeriod(3), 'night');
      assert.equal(getTimePeriod(4), 'early_morning');
      assert.equal(getTimePeriod(8), 'morning');
      assert.equal(getTimePeriod(12), 'afternoon');
      assert.equal(getTimePeriod(16), 'evening');
      assert.equal(getTimePeriod(20), 'late_evening');
      assert.equal(getTimePeriod(23), 'late_evening');
    });
  });
});
