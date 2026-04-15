import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHostSnapshots, seedContainerSnapshots, markContainerRemoved } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const { computeBaselines } = require('../../hub/src/insights/baselines');
const { generateInsights } = require('../../hub/src/insights/detector');

function seedHost(db: any, hostId: string, lastSeen: string) {
  db.prepare('INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))').run(hostId, lastSeen, lastSeen);
}

describe('detector', () => {
  let db: any, restore: () => void;

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
      assert.ok(insights.some((i: any) => i.title.includes('CPU')));
    });
  });

  describe('predictions', () => {
    it('generates prediction when memory trends toward 80% of total capacity', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Baseline so the live-value-vs-P75 check doesn't skip us.
      db.prepare(`
        INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
        VALUES ('host', 'h1', 'memory_used_mb', 'all', 2800, 2900, 3000, 3050, 3100, 2500, 3100, 300, datetime('now'))
      `).run();

      // 4 GB total → saturation = 3200 MB. Grow from 2500 → 3100 MB over 7 days
      // (~86 MB/day). Current 3100, remaining to 3200 = 100 → fires in ~1 day.
      for (let day = 6; day >= 0; day--) {
        for (let sample = 0; sample < 12; sample++) {
          const memUsed = 2500 + Math.round((6 - day) * 100);
          seedHostSnapshots(db, [{
            hostId: 'h1', cpu: 35, memTotal: 4000, memUsed, memAvail: 4000 - memUsed,
            load1: 1, at: ts(new Date(NOW - day * 86400000 - sample * 300000)),
          }]);
        }
      }

      generateInsights(db);

      const predictions = db.prepare("SELECT * FROM insights WHERE category = 'prediction'").all();
      assert.ok(predictions.length > 0, 'Should generate at least one prediction insight');
      assert.ok(predictions[0].message.includes('saturation'),
        `expected message to mention saturation, got: ${predictions[0].message}`);
    });

    it('does NOT generate prediction when memory is trending up but far from saturation', () => {
      // Regression for the media-host false positive: 20 GB total memory, used
      // around 1.5 GB, drifting slowly upward. P90 is tiny but saturation
      // (80% of 20 GB = 16 GB) is nowhere near the current value — so no insight.
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      db.prepare(`
        INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
        VALUES ('host', 'h1', 'memory_used_mb', 'all', 1400, 1500, 1600, 1700, 1800, 1300, 1900, 300, datetime('now'))
      `).run();

      for (let day = 6; day >= 0; day--) {
        for (let sample = 0; sample < 12; sample++) {
          const memUsed = 1400 + (6 - day) * 30; // 1400 → 1580 over a week
          seedHostSnapshots(db, [{
            hostId: 'h1', cpu: 20, memTotal: 20000, memUsed, memAvail: 20000 - memUsed,
            load1: 1, at: ts(new Date(NOW - day * 86400000 - sample * 300000)),
          }]);
        }
      }

      generateInsights(db);
      const predictions = db.prepare("SELECT * FROM insights WHERE category = 'prediction' AND metric = 'memory_used_mb'").all();
      assert.equal(predictions.length, 0, 'Slow drift at 8% of capacity should not fire a prediction');
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

  describe('downtime insight filter', () => {
    it('flags a container that was briefly down but has recovered', () => {
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // 6 hours down, then currently running.
      for (let h = 23; h > 6; h--) {
        seedContainerSnapshots(db, [{ hostId: 'h1', name: 'svc', status: 'running', cpu: 5, mem: 50, at: ts(new Date(NOW - h * 3600_000)) }]);
      }
      for (let h = 6; h > 1; h--) {
        seedContainerSnapshots(db, [{ hostId: 'h1', name: 'svc', status: 'exited', cpu: 0, mem: 0, at: ts(new Date(NOW - h * 3600_000)) }]);
      }
      seedContainerSnapshots(db, [{ hostId: 'h1', name: 'svc', status: 'running', cpu: 5, mem: 50, at: recent }]);

      generateInsights(db);
      const rows = db.prepare("SELECT * FROM insights WHERE entity_id = 'h1/svc' AND category = 'availability'").all();
      assert.equal(rows.length, 1);
      assert.match(rows[0].message, /recovered/);
    });

    it('does NOT flag a long-stopped container as "had downtime"', () => {
      // Regression for the proxmox-01/nginx noise: nginx was intentionally
      // stopped 15 days ago, so the 24h uptime window sees near-0% running.
      // The old filter `uptimePct > 0` let a single accidental running sample
      // through as a critical "had downtime" insight on every detector run.
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      for (let i = 0; i < 50; i++) {
        seedContainerSnapshots(db, [{ hostId: 'h1', name: 'old-nginx', status: 'exited', cpu: 0, mem: 0, at: ts(new Date(NOW - i * 300_000)) }]);
      }

      generateInsights(db);
      const rows = db.prepare("SELECT * FROM insights WHERE entity_id = 'h1/old-nginx' AND category = 'availability'").all();
      assert.equal(rows.length, 0, `long-stopped container should not produce a downtime insight, got: ${JSON.stringify(rows)}`);
    });

    it('skips containers that have stopped being reported (removed pods/containers)', () => {
      // Same class of leak the alert evaluator had: a container whose
      // registry row is marked `removed_at` should not regenerate insights
      // from its historical snapshots.
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      // Seed a container with a clear restart-loop history (>=3 restarts
      // over the last 24h). Its registry row is then flagged as removed,
      // so the detector should skip it entirely even though the snapshots
      // are still in the DB.
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'ghost', status: 'running', cpu: 5, mem: 50, restarts: 2, at: ts(new Date(NOW - 60 * 60 * 1000)) },
        { hostId: 'h1', name: 'ghost', status: 'running', cpu: 5, mem: 50, restarts: 8, at: ts(new Date(NOW - 30 * 60 * 1000)) },
      ]);
      markContainerRemoved(db, 'h1', 'ghost');

      generateInsights(db);
      const rows = db.prepare("SELECT * FROM insights WHERE entity_id = 'h1/ghost'").all();
      assert.equal(rows.length, 0, `removed container should not produce insights, got: ${JSON.stringify(rows)}`);
    });

    it('still generates insights for an actively reporting container with the same history', () => {
      // Inverse of the previous test: same restart-loop history, but the
      // latest snapshot is fresh, so the detector should process it.
      const recent = ts(new Date(NOW - 2 * 60 * 1000));
      seedHost(db, 'h1', recent);

      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'alive', status: 'running', cpu: 5, mem: 50, restarts: 2, at: ts(new Date(NOW - 60 * 60 * 1000)) },
        { hostId: 'h1', name: 'alive', status: 'running', cpu: 5, mem: 50, restarts: 8, at: recent },
      ]);

      generateInsights(db);
      const rows = db.prepare("SELECT * FROM insights WHERE entity_id = 'h1/alive' AND category = 'availability'").all();
      assert.ok(rows.length >= 1, `active container with restart history should still get insights, got: ${JSON.stringify(rows)}`);
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
      const hasCorrelation = perfInsights.some((i: any) => i.message.includes('may be related to'));
      assert.ok(hasCorrelation, 'Performance insight should include correlation with postgres status change');
    });
  });
});
