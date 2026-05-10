import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const explain = require('../../hub/src/insights/explain');

function tsAt(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function seedInsight(db: any, opts: {
  id?: number; entity_type: string; entity_id: string; category: string;
  severity?: string; title?: string; message?: string;
  metric?: string | null; current_value?: number | null; baseline_value?: number | null;
  evidence?: string | null; suggested_action?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}) {
  const stmt = db.prepare(`
    INSERT INTO insights (id, entity_type, entity_id, category, severity, title, message,
      metric, current_value, baseline_value, evidence, suggested_action, confidence, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    opts.id ?? null,
    opts.entity_type, opts.entity_id, opts.category,
    opts.severity ?? 'warning',
    opts.title ?? 'test',
    opts.message ?? 'msg',
    opts.metric ?? null,
    opts.current_value ?? null,
    opts.baseline_value ?? null,
    opts.evidence ?? null,
    opts.suggested_action ?? null,
    opts.confidence ?? null,
    opts.computed_at,
  );
  return db.prepare('SELECT * FROM insights WHERE rowid = last_insert_rowid()').get();
}

describe('insights explain', () => {
  let db: any;
  let restore: () => void;
  const NOW = new Date('2026-05-10T12:00:00Z');

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  describe('buildChart', () => {
    it('returns a sparkline for a performance host insight', () => {
      const insertSnap = db.prepare(`
        INSERT INTO host_snapshots (host_id, cpu_percent, memory_total_mb, memory_used_mb, load_5, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 24; i >= 0; i--) {
        const t = new Date(NOW.getTime() - i * 60 * 60 * 1000);
        insertSnap.run('h1', 50 + i, 8000, 4000, 1.0, tsAt(t));
      }
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'performance',
        metric: 'host.cpu_percent', current_value: 74, baseline_value: 70,
        title: 'High CPU', message: 'm', computed_at: tsAt(NOW),
      });

      const chart = explain.buildChart(db, insight);

      assert.equal(chart.kind, 'sparkline');
      assert.ok(chart.points.length > 0, 'expected non-empty points');
      assert.equal(chart.threshold, 70);
      assert.equal(chart.yLabel, '%');
    });

    it('returns sparkline kind for health and right_sizing', () => {
      for (const category of ['health', 'right_sizing'] as const) {
        const insight = seedInsight(db, {
          entity_type: 'host', entity_id: 'h1', category,
          metric: 'host.cpu_percent', title: 't', message: 'm',
          computed_at: tsAt(NOW),
        });
        const chart = explain.buildChart(db, insight);
        assert.equal(chart.kind, 'sparkline', `category=${category}`);
      }
    });

    it('returns uptime_bars for an availability insight', () => {
      db.prepare(`
        INSERT INTO container_snapshots
          (host_id, container_name, container_id, status, collected_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('h1', 'api', 'abc', 'running', tsAt(NOW));

      db.prepare(`
        INSERT INTO alert_state
          (host_id, alert_type, target, triggered_at, resolved_at)
        VALUES (?, 'container_down', ?, ?, ?)
      `).run('h1', 'h1/api',
        tsAt(new Date(NOW.getTime() - 5 * 60 * 60 * 1000)),
        tsAt(new Date(NOW.getTime() - 4 * 60 * 60 * 1000)),
      );

      const insight = seedInsight(db, {
        entity_type: 'container', entity_id: 'h1/api',
        category: 'availability', metric: null,
        title: 'Downtime', message: 'm', computed_at: tsAt(NOW),
      });

      const chart = explain.buildChart(db, insight);

      assert.equal(chart.kind, 'uptime_bars');
      assert.ok(chart.uptime && chart.uptime.length > 0, 'expected uptime intervals');
      assert.ok(chart.uptime!.some((iv: any) => iv.up === false), 'expected at least one down interval');
    });

    it('returns forecast cone for a disk_fill prediction insight', () => {
      const insertDisk = db.prepare(`
        INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 14 * 24; i >= 0; i--) {
        const t = new Date(NOW.getTime() - i * 60 * 60 * 1000);
        const pct = 50 + (14 * 24 - i) * 0.05;
        insertDisk.run('h1', '/', 1000, Math.round(pct * 10) / 10, pct, tsAt(t));
      }
      const insight = seedInsight(db, {
        entity_type: 'disk', entity_id: 'h1//',
        category: 'prediction', metric: 'disk.percent',
        current_value: 80, baseline_value: 90,
        title: 'Disk fill ETA', message: 'projected to fill in 14d',
        evidence: JSON.stringify({
          lines: ['Disk projected to reach 90% in 14d'],
          forecast: { horizon_hours: 14 * 24, mid: 92, lower: 88, upper: 96 },
          log_bursts: [],
        }),
        computed_at: tsAt(NOW),
      });

      const chart = explain.buildChart(db, insight);

      assert.equal(chart.kind, 'forecast');
      assert.ok(chart.forecast && chart.forecast.length > 0, 'forecast points');
      assert.equal(chart.threshold, 90);
    });

    it('returns week_overlay with this-week + last-week series for trend', () => {
      const insertSnap = db.prepare(`
        INSERT INTO host_snapshots (host_id, cpu_percent, memory_total_mb, memory_used_mb, load_5, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 14 * 24; i >= 0; i--) {
        const t = new Date(NOW.getTime() - i * 60 * 60 * 1000);
        insertSnap.run('h1', 60, 8000, 4000, 1.0, tsAt(t));
      }
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'trend',
        metric: 'host.cpu_percent', current_value: 75, baseline_value: 60,
        title: 'CPU trend', message: 'm', computed_at: tsAt(NOW),
      });

      const chart = explain.buildChart(db, insight);

      assert.equal(chart.kind, 'week_overlay');
      assert.ok(chart.points.length > 0, 'this-week points');
      assert.ok(chart.compare && chart.compare.length > 0, 'last-week points');
    });
  });

  describe('buildTimeline', () => {
    it('merges log bursts, alert fires, restart deltas, and threshold crossings, sorted oldest→newest, capped at 25', () => {
      const burstTs = tsAt(new Date(NOW.getTime() - 30 * 60 * 1000));
      const insight = seedInsight(db, {
        entity_type: 'container', entity_id: 'h1/api',
        category: 'performance', metric: 'container.cpu_percent',
        current_value: 95, baseline_value: 70,
        evidence: JSON.stringify({
          lines: ['m'],
          log_bursts: [{
            id: 1, template_id: 1, template: 'oom kill',
            semantic_tag: 'oom', ts: burstTs, batch_count: 3,
            baseline_rate: 0.1, intensity: 30,
          }],
        }),
        title: 't', message: 'm', computed_at: tsAt(NOW),
      });
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, resolved_at)
        VALUES ('h1', 'container_high_cpu', 'h1/api', ?, NULL)
      `).run(tsAt(new Date(NOW.getTime() - 10 * 60 * 1000)));
      const insertSnap = db.prepare(`
        INSERT INTO container_snapshots
          (host_id, container_name, container_id, status, cpu_percent, restart_count, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertSnap.run('h1', 'api', 'abc', 'running', 50, 0, tsAt(new Date(NOW.getTime() - 60 * 60 * 1000)));
      insertSnap.run('h1', 'api', 'abc', 'running', 95, 1, tsAt(new Date(NOW.getTime() - 50 * 60 * 1000)));
      const points = [
        { ts: tsAt(new Date(NOW.getTime() - 40 * 60 * 1000)), value: 60 },
        { ts: tsAt(new Date(NOW.getTime() - 30 * 60 * 1000)), value: 80 },
      ];

      const tl = explain.buildTimeline(db, insight, points);

      const kinds = tl.map((m: any) => m.kind);
      assert.ok(kinds.includes('log_burst'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('alert_fired'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('restart'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('threshold_cross'), `kinds=${kinds.join(',')}`);
      const tsList = tl.map((m: any) => m.ts);
      assert.deepEqual([...tsList].sort(), tsList);
      assert.ok(tl.length <= 25, `cap exceeded: ${tl.length}`);
    });
  });

  describe('buildExplanation', () => {
    it('returns summary + chart + timeline for a basic insight', () => {
      const insertSnap = db.prepare(`
        INSERT INTO host_snapshots (host_id, cpu_percent, memory_total_mb, memory_used_mb, load_5, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 24; i >= 0; i--) {
        const t = new Date(NOW.getTime() - i * 60 * 60 * 1000);
        insertSnap.run('h1', 50 + i, 8000, 4000, 1.0, tsAt(t));
      }
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'performance',
        metric: 'host.cpu_percent', current_value: 74, baseline_value: 70,
        title: 'High CPU', message: 'm', computed_at: tsAt(NOW),
      });

      const out = explain.buildExplanation(db, insight);

      assert.ok(out.summary && out.summary.lead, 'has summary');
      assert.equal(out.chart.kind, 'sparkline');
      assert.ok(Array.isArray(out.timeline), 'has timeline array');
    });
  });

  describe('buildSummary', () => {
    it('synthesizes a summary for a capacity-based performance insight', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1',
        category: 'performance', metric: 'host.cpu_percent',
        title: 'High CPU on h1', message: 'CPU at 92%',
        current_value: 92, baseline_value: 70,
        confidence: 'medium', computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.equal(summary.confidence, 'medium');
      assert.match(summary.lead, /h1/);
      assert.ok(summary.reasons.length >= 1, 'expected at least one reason');
      assert.ok(
        summary.reasons.some((r: string) => r.includes('92')),
        `expected current value in reasons; got ${JSON.stringify(summary.reasons)}`,
      );
    });

    it('preserves diagnosis-engine evidence order when present', () => {
      const evidenceObj = {
        lines: ['OOM kills detected in last 30m', 'Memory above 95% for 3h', 'Restart loop pattern'],
        log_bursts: [],
      };
      const insight = seedInsight(db, {
        entity_type: 'container', entity_id: 'h1/api',
        category: 'health', title: 'Container unhealthy', message: 'fails health check',
        evidence: JSON.stringify(evidenceObj), confidence: 'high',
        computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.deepEqual(summary.reasons, evidenceObj.lines);
      assert.equal(summary.confidence, 'high');
    });

    it('tolerates legacy string-array evidence shape', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'health',
        title: 't', message: 'm',
        evidence: JSON.stringify(['legacy reason 1', 'legacy reason 2']),
        computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.deepEqual(summary.reasons, ['legacy reason 1', 'legacy reason 2']);
    });

    it('falls back to synthesis when evidence JSON is malformed', () => {
      const insight = seedInsight(db, {
        entity_type: 'host', entity_id: 'h1', category: 'performance',
        metric: 'host.cpu_percent', current_value: 80,
        evidence: 'not-json',
        title: 't', message: 'm', computed_at: tsAt(NOW),
      });

      const summary = explain.buildSummary(insight);

      assert.ok(summary.reasons.some((r: string) => r.includes('80')));
    });
  });
});
