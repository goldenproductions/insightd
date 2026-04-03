const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedHostSnapshots, seedContainerSnapshots, seedAlertState } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const { computeBaselines } = require('../../hub/src/insights/baselines');
const { generateInsights } = require('../../hub/src/insights/detector');

function seedHost(db, hostId, lastSeen) {
  db.prepare('INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))').run(hostId, lastSeen, lastSeen);
}

describe('detector', () => {
  let db, restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  describe('sustained elevation', () => {
    it('generates performance insight when metric exceeds P95 for 6+ snapshots', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Manually insert a baseline with known thresholds and sufficient sample count
      db.prepare(`
        INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
        VALUES ('host', 'h1', 'cpu_percent', 'all', 25, 30, 35, 38, 40, 20, 40, 300, datetime('now'))
      `).run();

      // Seed 6 recent snapshots with CPU=95 (well above P95=38)
      for (let i = 0; i < 6; i++) {
        seedHostSnapshots(db, [{
          hostId: 'h1', cpu: 95, memTotal: 8000, memUsed: 4000, memAvail: 4000,
          load1: 1, at: ts(new Date(NOW - i * 300000)),
        }]);
      }

      generateInsights(db);

      const insights = db.prepare("SELECT * FROM insights WHERE category = 'performance'").all();
      assert.ok(insights.length > 0, 'Should generate at least one performance insight');
      assert.ok(insights.some(i => i.title.includes('CPU')));
    });
  });

  describe('predictions', () => {
    it('generates prediction for steadily growing metric', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Manually insert a baseline with known P90
      db.prepare(`
        INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
        VALUES ('host', 'h1', 'memory_used_mb', 'all', 3000, 3200, 3500, 3700, 3900, 2800, 4000, 300, datetime('now'))
      `).run();

      // Seed 7 days of steadily growing memory: 2800 → 3400 (below P90=3500, growing 100/day → exceeds in ~1 day)
      for (let day = 6; day >= 0; day--) {
        for (let sample = 0; sample < 12; sample++) {
          const memUsed = 2800 + (6 - day) * 100;
          seedHostSnapshots(db, [{
            hostId: 'h1', cpu: 35, memTotal: 8000, memUsed, memAvail: 8000 - memUsed,
            load1: 1, at: ts(new Date(NOW - day * 86400000 - sample * 300000)),
          }]);
        }
      }

      generateInsights(db);

      const predictions = db.prepare("SELECT * FROM insights WHERE category = 'prediction'").all();
      assert.ok(predictions.length > 0, 'Should generate at least one prediction insight');
      assert.ok(predictions[0].message.includes('growing'));
    });

    it('does not generate prediction for flat metrics', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Seed baselines
      for (let i = 0; i < 300; i++) {
        seedHostSnapshots(db, [{
          hostId: 'h1', cpu: 30, memTotal: 8000, memUsed: 3000, memAvail: 5000,
          load1: 1, at: ts(new Date(NOW - (i + 10) * 300000)),
        }]);
      }
      computeBaselines(db);

      // Seed 7 days of flat data
      db.prepare("DELETE FROM host_snapshots WHERE host_id = 'h1'").run();
      for (let day = 6; day >= 0; day--) {
        for (let sample = 0; sample < 12; sample++) {
          seedHostSnapshots(db, [{
            hostId: 'h1', cpu: 30, memTotal: 8000, memUsed: 3000, memAvail: 5000,
            load1: 1, at: ts(new Date(NOW - day * 86400000 - sample * 300000)),
          }]);
        }
      }

      generateInsights(db);

      const predictions = db.prepare("SELECT * FROM insights WHERE category = 'prediction'").all();
      assert.equal(predictions.length, 0, 'Should not generate prediction for flat metrics');
    });
  });

  describe('cascade detection', () => {
    it('collapses multiple container availability insights into host-level', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Seed 4 containers, all with downtime
      for (const name of ['nginx', 'redis', 'postgres', 'app']) {
        seedContainerSnapshots(db, [
          { hostId: 'h1', name, status: 'running', cpu: 5, mem: 50, at: ts(new Date(NOW - 12 * 60 * 60 * 1000)) },
          { hostId: 'h1', name, status: 'exited', cpu: 0, mem: 0, at: ts(new Date(NOW - 6 * 60 * 60 * 1000)) },
          { hostId: 'h1', name, status: 'running', cpu: 5, mem: 50, at: recent },
        ]);
      }

      generateInsights(db);

      const containerAvails = db.prepare("SELECT * FROM insights WHERE entity_type = 'container' AND category = 'availability'").all();
      const hostAvails = db.prepare("SELECT * FROM insights WHERE entity_type = 'host' AND category = 'availability'").all();

      assert.equal(containerAvails.length, 0, 'Individual container availability insights should be collapsed');
      assert.equal(hostAvails.length, 1, 'Should have one host-level availability insight');
      assert.ok(hostAvails[0].message.includes('containers affected'));
    });
  });

  describe('temporal correlation', () => {
    it('enriches insight messages with related events', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Manually insert baseline
      db.prepare(`
        INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
        VALUES ('host', 'h1', 'cpu_percent', 'all', 25, 30, 35, 38, 40, 20, 40, 300, datetime('now'))
      `).run();

      // Seed 6 recent high-CPU snapshots to trigger a performance insight
      for (let i = 0; i < 6; i++) {
        seedHostSnapshots(db, [{
          hostId: 'h1', cpu: 95, memTotal: 8000, memUsed: 4000, memAvail: 4000,
          load1: 1, at: ts(new Date(NOW - i * 300000)),
        }]);
      }

      // Seed a container status change within the last hour (for correlation)
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'postgres', status: 'running', cpu: 5, mem: 50, at: ts(new Date(NOW - 40 * 60 * 1000)) },
        { hostId: 'h1', name: 'postgres', status: 'exited', cpu: 0, mem: 0, at: ts(new Date(NOW - 30 * 60 * 1000)) },
      ]);

      generateInsights(db);

      const perfInsights = db.prepare("SELECT * FROM insights WHERE category = 'performance'").all();
      assert.ok(perfInsights.length > 0);
      const hasCorrelation = perfInsights.some(i => i.message.includes('may be related to'));
      assert.ok(hasCorrelation, 'Performance insight should include correlation with postgres status change');
    });
  });
});
