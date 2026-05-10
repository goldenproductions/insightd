import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { dailyTrend } = require('../../hub/src/insights/disk-fill');

describe('dailyTrend helper', () => {
  it('returns null when fewer than 4 days', () => {
    const daily = [
      { day: '2026-05-04', avg: 50 },
      { day: '2026-05-05', avg: 51 },
      { day: '2026-05-06', avg: 52 },
    ];
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when relative growth < 1% of current', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 1000 + i * 0.5, // 0.5 GB/day on a 1000 GB current = 0.05% — under floor
    }));
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when absolute growth < minimum', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 50 + i * 0.01, // 0.01 GB/day, below 0.05 GB/day floor
    }));
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when fewer than half of day pairs agree with positive trend', () => {
    const daily = [
      { day: 'd1', avg: 50 },
      { day: 'd2', avg: 50 },
      { day: 'd3', avg: 50 },
      { day: 'd4', avg: 50 },
      { day: 'd5', avg: 60 },  // last - first = 10, but only 1/4 days are increasing
    ];
    const out = dailyTrend(daily, 0.05);
    assert.equal(out, null);
  });

  it('returns slope, current, dayCount on a clean rising trend', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 50 + i * 1, // 1 GB/day
    }));
    const out = dailyTrend(daily, 0.05);
    assert.ok(out);
    assert.equal(out!.dayCount, 7);
    assert.equal(out!.current, 56);
    assert.equal(Math.round(out!.dailyGrowth * 100) / 100, 1);
  });
});

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { generateInsights } = require('../../hub/src/insights/detector');

interface InsightRow {
  entity_type: string; entity_id: string; category: string; severity: string;
  title: string; message: string; metric: string | null;
  current_value: number | null; baseline_value: number | null;
  evidence: string | null; suggested_action: string | null; confidence: string | null;
}

describe('detector — disk-fill ETA insights', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('node-1', datetime('now'), datetime('now'))`).run();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  /**
   * Seed N days of disk snapshots, one per day at noon, with linear growth.
   * day 0 = 7 days ago. day 6 = today. usedAtDayN = startGb + dailyGrowthGb * N.
   */
  function seedDisk(opts: {
    hostId?: string;
    mount?: string;
    totalGb: number;
    startGb: number;
    dailyGrowthGb: number;
    days?: number;
  }): void {
    const hostId = opts.hostId ?? 'node-1';
    const mount = opts.mount ?? '/';
    const totalGb = opts.totalGb;
    const days = opts.days ?? 7;
    for (let d = 0; d < days; d++) {
      const usedGb = opts.startGb + opts.dailyGrowthGb * d;
      const usedPct = (usedGb / totalGb) * 100;
      const at = `datetime('now', '-${days - 1 - d} days')`;
      db.prepare(`
        INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
        VALUES (?, ?, ?, ?, ?, ${at})
      `).run(hostId, mount, totalGb, usedGb, usedPct);
    }
  }

  /**
   * Seed N days of pve_storage snapshots in bytes. Mirrors seedDisk shape.
   */
  function seedPveStorage(opts: {
    hostId?: string;
    storageName?: string;
    storageType?: string;
    totalBytes: number;
    startBytes: number;
    dailyGrowthBytes: number;
    days?: number;
    active?: number;
  }): void {
    const hostId = opts.hostId ?? 'node-1';
    const storageName = opts.storageName ?? 'local-zfs';
    const storageType = opts.storageType ?? 'zfspool';
    const days = opts.days ?? 7;
    const active = opts.active ?? 1;
    for (let d = 0; d < days; d++) {
      const used = opts.startBytes + opts.dailyGrowthBytes * d;
      const at = `datetime('now', '-${days - 1 - d} days')`;
      db.prepare(`
        INSERT INTO pve_storage_snapshots (host_id, storage_name, storage_type, total_bytes, used_bytes, active, shared, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ${at})
      `).run(hostId, storageName, storageType, opts.totalBytes, used, active);
    }
  }

  function getDiskFillInsights(): InsightRow[] {
    return db.prepare(
      `SELECT entity_type, entity_id, category, severity, title, message, metric,
              current_value, baseline_value, evidence, suggested_action, confidence
       FROM insights
       WHERE category = 'prediction'
         AND (metric = 'disk_used_percent' OR metric = 'pve_storage_used_percent')`
    ).all() as InsightRow[];
  }

  // Tests will be added in subsequent tasks — start with a smoke test that
  // confirms the no-op module runs cleanly inside generateInsights.
  it('runs cleanly with no disk data', () => {
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('fires a warning insight when disk fills in 8 days at 5 GB/day on a 100 GB disk at 60%', () => {
    // 60 GB used today, growing 5 GB/day. Remaining = 40 GB → 8 days. Warning band.
    // 7 daily samples spanning days 0..6, last - first = 6 * dailyGrowth.
    // For dailyGrowth=5 we need startGb such that day-6 = 60. startGb = 60 - 5*6 = 30.
    seedDisk({ totalGb: 100, startGb: 30, dailyGrowthGb: 5 });

    generateInsights(db);

    const insights = getDiskFillInsights();
    assert.equal(insights.length, 1, `expected one disk-fill insight, got: ${JSON.stringify(insights)}`);
    const i = insights[0]!;
    assert.equal(i.entity_type, 'host');
    assert.equal(i.entity_id, 'node-1');
    assert.equal(i.severity, 'warning');
    assert.equal(i.metric, 'disk_used_percent');
    assert.match(i.title, /Disk "\/" on node-1 filling up/);
    assert.match(i.message, /full in ~8 days/);
    assert.equal(i.confidence, 'medium');
  });

  it('fires critical when ETA <= 3 days', () => {
    // 7 daily samples, day 0 = 10 GB used, day 6 = 70 GB used. Last avg = 70.
    // Slope = (70-10)/6 = 10. Remaining = 30. daysUntil = round(30/10) = 3 → critical at boundary.
    seedDisk({ totalGb: 100, startGb: 10, dailyGrowthGb: 10 });
    generateInsights(db);
    const insights = getDiskFillInsights();
    assert.equal(insights.length, 1);
    assert.equal(insights[0]!.severity, 'critical');
    assert.match(insights[0]!.message, /full in ~3 days/);
  });

  it('does not fire when ETA > 14 days', () => {
    // 60% used, growing 1 GB/day on 100 GB → 40 days. Above horizon.
    seedDisk({ totalGb: 100, startGb: 54, dailyGrowthGb: 1 });
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('does not fire when disk is shrinking', () => {
    // Used decreasing 5 GB/day from 95 GB ⇒ ends at 65 GB, still over floor, but slope is negative.
    seedDisk({ totalGb: 100, startGb: 95, dailyGrowthGb: -5 });
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('does not fire when disk is flat', () => {
    // 70 GB used, no daily change.
    seedDisk({ totalGb: 100, startGb: 70, dailyGrowthGb: 0 });
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('does not fire when used_percent < 50% (floor)', () => {
    // 30 GB used today, growing 5 GB/day, 100 GB total → ETA 14 days, but below floor.
    seedDisk({ totalGb: 100, startGb: 0, dailyGrowthGb: 5 });
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('does not fire with fewer than 4 days of data', () => {
    // Only 3 days seeded, all above floor.
    seedDisk({ totalGb: 100, startGb: 60, dailyGrowthGb: 5, days: 3 });
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('does not fire when an open disk_full alert exists for the same (host, mount)', () => {
    seedDisk({ totalGb: 100, startGb: 30, dailyGrowthGb: 5 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, message, trigger_value)
      VALUES ('node-1', 'disk_full', '/', datetime('now'), datetime('now'), 'disk full', '90')
    `).run();
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 0);
  });

  it('still fires when a disk_full alert exists but is resolved', () => {
    seedDisk({ totalGb: 100, startGb: 30, dailyGrowthGb: 5 });
    db.prepare(`
      INSERT INTO alert_state (host_id, alert_type, target, triggered_at, resolved_at, last_notified, message, trigger_value)
      VALUES ('node-1', 'disk_full', '/', datetime('now', '-2 days'), datetime('now', '-1 day'), datetime('now', '-2 days'), 'disk full', '90')
    `).run();
    generateInsights(db);
    assert.equal(getDiskFillInsights().length, 1);
  });

  it('fires only for mounts above the floor when multiple mounts on one host', () => {
    seedDisk({ totalGb: 100, startGb: 30, dailyGrowthGb: 5, mount: '/' });
    seedDisk({ totalGb: 100, startGb: 5, dailyGrowthGb: 5, mount: '/var/log' }); // ends at 35% — below floor
    generateInsights(db);
    const insights = getDiskFillInsights();
    assert.equal(insights.length, 1);
    assert.match(insights[0]!.title, /Disk "\/" on node-1/);
  });

  it('embeds expected fields in evidence JSON', () => {
    seedDisk({ totalGb: 100, startGb: 30, dailyGrowthGb: 5 });
    generateInsights(db);
    const i = getDiskFillInsights()[0]!;
    const evidence = JSON.parse(i.evidence!);
    assert.equal(evidence.mount_point, '/');
    assert.equal(typeof evidence.used_gb, 'number');
    assert.equal(typeof evidence.total_gb, 'number');
    assert.equal(typeof evidence.daily_growth_gb, 'number');
    assert.equal(evidence.day_count, 7);
  });
});
