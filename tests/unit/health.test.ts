import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHostSnapshots, seedContainerSnapshots, seedAlertState, seedBaselines } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');

const { computeHealthScores, scoreMetricVsBaseline, rateValue } = require('../../hub/src/insights/health') as {
  computeHealthScores: (db: any) => void;
  scoreMetricVsBaseline: (value: number | null | undefined, baseline: any) => number;
  rateValue: (value: number | null | undefined, baseline: any) => string;
};

const recent = ts(new Date(NOW - 60 * 1000));
const old = ts(new Date(NOW - 60 * 60 * 1000));

function seedOnlineHost(db: any, hostId: string): void {
  db.prepare("INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))").run(hostId, recent, recent);
}

function getHostScore(db: any, hostId: string): { score: number; factors: any } {
  const row = db.prepare("SELECT score, factors FROM health_scores WHERE entity_type = 'host' AND entity_id = ?").get(hostId);
  return { score: row.score, factors: JSON.parse(row.factors) };
}

function getContainerScore(db: any, hostId: string, name: string): { score: number; factors: any } {
  const row = db.prepare("SELECT score, factors FROM health_scores WHERE entity_type = 'container' AND entity_id = ?").get(`${hostId}/${name}`);
  return { score: row.score, factors: JSON.parse(row.factors) };
}

describe('insights/health', () => {
  let db: any;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  describe('scoreMetricVsBaseline', () => {
    const baseline = { metric: 'cpu', p50: 10, p75: 20, p90: 40, p95: 60, p99: 80, sample_count: 500 };

    it('returns 100 (full credit) when value is at or below P75', () => {
      assert.equal(scoreMetricVsBaseline(15, baseline), 100);
      assert.equal(scoreMetricVsBaseline(20, baseline), 100);
    });
    it('returns 80 between P75 and P90', () => {
      assert.equal(scoreMetricVsBaseline(30, baseline), 80);
    });
    it('returns 50 between P90 and P95', () => {
      assert.equal(scoreMetricVsBaseline(50, baseline), 50);
    });
    it('returns 20 between P95 and P99', () => {
      assert.equal(scoreMetricVsBaseline(70, baseline), 20);
    });
    it('returns 0 above P99', () => {
      assert.equal(scoreMetricVsBaseline(99, baseline), 0);
    });
    it('returns 100 (cold start) when sample_count < 288', () => {
      const cold = { ...baseline, sample_count: 50 };
      assert.equal(scoreMetricVsBaseline(99, cold), 100);
    });
    it('returns 100 when value is null/undefined (no signal to penalize)', () => {
      assert.equal(scoreMetricVsBaseline(null, baseline), 100);
      assert.equal(scoreMetricVsBaseline(undefined, baseline), 100);
    });
    it('returns 100 when no baseline is supplied', () => {
      assert.equal(scoreMetricVsBaseline(99, undefined), 100);
    });
  });

  describe('rateValue', () => {
    const baseline = { metric: 'cpu', p50: 10, p75: 20, p90: 40, p95: 60, p99: 80, sample_count: 500 };

    it('rates as normal at or below P75', () => {
      assert.equal(rateValue(20, baseline), 'normal');
    });
    it('rates as elevated between P75 and P90', () => {
      assert.equal(rateValue(30, baseline), 'elevated');
    });
    it('rates as high between P90 and P95', () => {
      assert.equal(rateValue(50, baseline), 'high');
    });
    it('rates as critical above P95', () => {
      assert.equal(rateValue(70, baseline), 'critical');
      assert.equal(rateValue(99, baseline), 'critical');
    });
    it('rates as normal during cold start', () => {
      assert.equal(rateValue(99, { ...baseline, sample_count: 0 }), 'normal');
    });
  });

  describe('computeHealthScores — host', () => {
    it('healthy host (low CPU, low memory, low load, online, no alerts) gets a perfect score', () => {
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load1: 0.3, load5: 0.4, load15: 0.5, at: recent }]);
      computeHealthScores(db);

      const { score, factors } = getHostScore(db, 'h1');
      assert.equal(score, 100);
      assert.equal(factors.cpu.rating, 'normal');
      assert.equal(factors.memory.rating, 'normal');
      assert.equal(factors.load.rating, 'normal');
      assert.equal(factors.online.rating, 'normal');
      assert.equal(factors.alerts.rating, 'normal');
    });

    it('CPU thresholds: 70 → elevated, 85 → high, 95 → critical', () => {
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 75, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.cpu.rating, 'elevated');

      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 90, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.cpu.rating, 'high');

      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 98, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.cpu.rating, 'critical');
    });

    it('Memory thresholds use percentage of total, not raw value', () => {
      seedOnlineHost(db, 'h1');
      // 1.4% used — would look "critical" against a baseline-based scorer; here it's normal
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 230, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.memory.rating, 'normal');

      // 85% used — elevated
      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 13927, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.memory.rating, 'elevated');

      // 96% used — critical
      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 15728, load5: 0.5, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.memory.rating, 'critical');
    });

    it('Load thresholds: 4 → elevated, 8 → high, 16 → critical', () => {
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 6, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.load.rating, 'elevated');

      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 12, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.load.rating, 'high');

      db.prepare('DELETE FROM host_snapshots').run();
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 20, at: recent }]);
      computeHealthScores(db);
      assert.equal(getHostScore(db, 'h1').factors.load.rating, 'critical');
    });

    it('flags offline host as critical online factor', () => {
      // last_seen 30 minutes ago → offline (>10 min threshold)
      const longAgo = ts(new Date(NOW - 30 * 60 * 1000));
      db.prepare("INSERT INTO hosts (host_id, first_seen, last_seen) VALUES (?, datetime(?), datetime(?))").run('h1', longAgo, longAgo);
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: longAgo }]);
      computeHealthScores(db);

      const { factors } = getHostScore(db, 'h1');
      assert.equal(factors.online.rating, 'critical');
      assert.equal(factors.online.score, 0);
    });

    it('penalizes for active alerts', () => {
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
      seedAlertState(db, [
        { hostId: 'h1', type: 'cpu', target: 'h1', triggeredAt: recent },
        { hostId: 'h1', type: 'disk', target: '/', triggeredAt: recent },
        { hostId: 'h1', type: 'memory', target: 'h1', triggeredAt: recent },
      ]);
      computeHealthScores(db);

      const { factors } = getHostScore(db, 'h1');
      assert.equal(factors.alerts.value, 3);
      assert.equal(factors.alerts.rating, 'critical');
      // 100 - 3*20 = 40
      assert.equal(factors.alerts.score, 40);
    });

    it('does not count resolved alerts', () => {
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
      seedAlertState(db, [
        { hostId: 'h1', type: 'cpu', target: 'h1', triggeredAt: old, resolvedAt: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getHostScore(db, 'h1');
      assert.equal(factors.alerts.value, 0);
      assert.equal(factors.alerts.rating, 'normal');
    });
  });

  describe('computeHealthScores — container', () => {
    beforeEach(() => {
      // We need at least one host for the host loop, and a host_snapshot so the host
      // computation has data — but the focus here is the container output.
      seedOnlineHost(db, 'h1');
      seedHostSnapshots(db, [{ hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent }]);
    });

    it('healthy container (low CPU, low memory, no restarts, healthy) gets a perfect score', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 50, restarts: 0, health: 'healthy', at: recent },
      ]);
      computeHealthScores(db);

      const { score, factors } = getContainerScore(db, 'h1', 'nginx');
      assert.equal(score, 100);
      assert.equal(factors.cpu.rating, 'normal');
      assert.equal(factors.uptime.rating, 'normal');
      assert.equal(factors.restarts.rating, 'normal');
      assert.equal(factors.health.rating, 'normal');
    });

    it('container CPU under 50% is always normal (regardless of baseline)', () => {
      // Even with a tight baseline (P75=2), 40% should still be rated normal
      seedBaselines(db, [
        { entityType: 'container', entityId: 'h1/nginx', metric: 'cpu_percent',
          p50: 1, p75: 2, p90: 3, p95: 4, p99: 5, sampleCount: 500 },
      ]);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 40, mem: 50, restarts: 0, health: 'healthy', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'nginx');
      assert.equal(factors.cpu.rating, 'normal');
      assert.equal(factors.cpu.score, 100);
    });

    it('container CPU 50–80% gets at least "elevated" rating even if baseline says critical', () => {
      seedBaselines(db, [
        { entityType: 'container', entityId: 'h1/nginx', metric: 'cpu_percent',
          p50: 1, p75: 2, p90: 3, p95: 4, p99: 5, sampleCount: 500 },
      ]);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 60, mem: 50, restarts: 0, health: 'healthy', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'nginx');
      // Capped at 'elevated' regardless of baseline indicating critical
      assert.equal(factors.cpu.rating, 'elevated');
      assert.ok(factors.cpu.score >= 70);
    });

    it('memory deviation < 50 MB above P75 is forced to normal', () => {
      seedBaselines(db, [
        { entityType: 'container', entityId: 'h1/nginx', metric: 'memory_mb',
          p50: 100, p75: 150, p90: 200, p95: 250, p99: 300, sampleCount: 500 },
      ]);
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'nginx', status: 'running', cpu: 5, mem: 180, restarts: 0, health: 'healthy', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'nginx');
      assert.equal(factors.memory.rating, 'normal');
    });

    it('penalizes restarts', () => {
      // Two snapshots with growing restart count
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'crashy', status: 'running', cpu: 5, mem: 50, restarts: 0, health: 'healthy', at: ts(new Date(NOW - 60 * 60 * 1000)) },
        { hostId: 'h1', name: 'crashy', status: 'running', cpu: 5, mem: 50, restarts: 4, health: 'healthy', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'crashy');
      assert.equal(factors.restarts.value, 4);
      assert.equal(factors.restarts.rating, 'critical');
      assert.equal(factors.restarts.score, 0);
    });

    it('penalizes downtime via uptime factor', () => {
      // 4 of 10 snapshots running → 40% uptime
      const rows = [];
      for (let i = 0; i < 6; i++) rows.push({ hostId: 'h1', name: 'flappy', status: 'exited', cpu: 0, mem: 0, restarts: 0, health: null, at: ts(new Date(NOW - (10 - i) * 60 * 1000)) });
      for (let i = 0; i < 4; i++) rows.push({ hostId: 'h1', name: 'flappy', status: 'running', cpu: 5, mem: 50, restarts: 0, health: 'healthy', at: ts(new Date(NOW - (4 - i) * 60 * 1000)) });
      seedContainerSnapshots(db, rows);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'flappy');
      assert.equal(Math.round(factors.uptime.value), 40);
      assert.equal(factors.uptime.rating, 'critical');
    });

    it('penalizes unhealthy health-check status', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'sick', status: 'running', cpu: 5, mem: 50, restarts: 0, health: 'unhealthy', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'sick');
      assert.equal(factors.health.value, 'unhealthy');
      assert.equal(factors.health.rating, 'critical');
    });

    it('treats "starting" health as elevated', () => {
      seedContainerSnapshots(db, [
        { hostId: 'h1', name: 'booting', status: 'running', cpu: 5, mem: 50, restarts: 0, health: 'starting', at: recent },
      ]);
      computeHealthScores(db);
      const { factors } = getContainerScore(db, 'h1', 'booting');
      assert.equal(factors.health.rating, 'elevated');
      assert.equal(factors.health.score, 50);
    });
  });

  describe('computeHealthScores — system', () => {
    it('writes a system entry that averages all host scores', () => {
      seedOnlineHost(db, 'h1');
      seedOnlineHost(db, 'h2');
      seedHostSnapshots(db, [
        { hostId: 'h1', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent },
        { hostId: 'h2', cpu: 10, memTotal: 16384, memUsed: 4096, load5: 0.5, at: recent },
      ]);
      computeHealthScores(db);

      const sys = db.prepare("SELECT score, factors FROM health_scores WHERE entity_type = 'system'").get();
      assert.ok(sys);
      assert.equal(sys.score, 100);
      const factors = JSON.parse(sys.factors);
      assert.equal(factors.hostCount, 2);
    });

    it('defaults to 100 when no hosts exist', () => {
      computeHealthScores(db);
      const sys = db.prepare("SELECT score FROM health_scores WHERE entity_type = 'system'").get();
      assert.equal(sys.score, 100);
    });
  });
});
