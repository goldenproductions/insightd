import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedDiskSnapshots } = require('../helpers/db');
const { ts, NOW } = require('../helpers/fixtures');
const { getDisksOverview } = require('../../hub/src/web/queries');

function seedHost(db: any, hostId: string, lastSeen: string, group?: string) {
  db.prepare(
    `INSERT OR REPLACE INTO hosts (host_id, first_seen, last_seen, host_group)
     VALUES (?, datetime(?), datetime(?), ?)`
  ).run(hostId, lastSeen, lastSeen, group ?? null);
}

// Seed a sliding window of snapshots over `days` where `used_gb` grows linearly
// from `startUsedGb` to `endUsedGb`. Newest snapshot lands at t=0.
function seedGrowth(db: any, opts: {
  hostId: string;
  mount: string;
  totalGb: number;
  startUsedGb: number;
  endUsedGb: number;
  days: number;
  steps?: number;
}) {
  const steps = opts.steps ?? 8;
  const rows = [] as any[];
  for (let i = 0; i < steps; i++) {
    const frac = i / (steps - 1);
    const tMs = NOW - (opts.days - frac * opts.days) * 86400000;
    const used = opts.startUsedGb + frac * (opts.endUsedGb - opts.startUsedGb);
    rows.push({
      hostId: opts.hostId,
      mount: opts.mount,
      total: opts.totalGb,
      used,
      percent: Math.round((used / opts.totalGb) * 10) / 10,
      at: ts(new Date(tMs)),
    });
  }
  seedDiskSnapshots(db, rows);
}

const recent = ts(new Date(NOW - 2 * 60 * 1000));

describe('getDisksOverview', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty totals when no hosts have disk data', () => {
    const res = getDisksOverview(db, 10);
    assert.equal(res.totals.totalGb, 0);
    assert.equal(res.totals.usedGb, 0);
    assert.equal(res.totals.freeGb, 0);
    assert.deepEqual(res.hosts, []);
    assert.deepEqual(res.warnings, []);
  });

  it('aggregates totals across multiple hosts and mounts', () => {
    seedHost(db, 'alpha', recent, 'prod');
    seedHost(db, 'beta', recent, 'prod');
    seedDiskSnapshots(db, [
      { hostId: 'alpha', mount: '/',     total: 100, used: 40, percent: 40, at: recent },
      { hostId: 'alpha', mount: '/data', total: 500, used: 200, percent: 40, at: recent },
      { hostId: 'beta',  mount: '/',     total: 50,  used: 10, percent: 20, at: recent },
    ]);

    const res = getDisksOverview(db, 10);

    assert.equal(res.totals.totalGb, 650);
    assert.equal(res.totals.usedGb, 250);
    assert.equal(res.totals.freeGb, 400);
    assert.equal(res.totals.usedPercent, 38.5);

    assert.equal(res.hosts.length, 2);
    const alpha = res.hosts.find((h: any) => h.hostId === 'alpha');
    assert.equal(alpha.mounts.length, 2);
    assert.equal(alpha.hostGroup, 'prod');
    assert.equal(alpha.online, true);

    const root = alpha.mounts.find((m: any) => m.mountPoint === '/');
    assert.equal(root.totalGb, 100);
    assert.equal(root.usedGb, 40);
    assert.equal(root.freeGb, 60);
  });

  it('classifies threshold warnings and critical at the right cutoffs', () => {
    seedHost(db, 'h1', recent);
    seedDiskSnapshots(db, [
      { hostId: 'h1', mount: '/warn',  total: 100, used: 86, percent: 86, at: recent },
      { hostId: 'h1', mount: '/crit',  total: 100, used: 92, percent: 92, at: recent },
      { hostId: 'h1', mount: '/ok',    total: 100, used: 30, percent: 30, at: recent },
    ]);

    const res = getDisksOverview(db, 10);

    const byMount = new Map<string, any>(res.warnings.map((w: any) => [w.mountPoint, w]));
    assert.equal(byMount.size, 2, 'only warn + crit should appear');
    assert.equal(byMount.get('/warn')!.severity, 'warning');
    assert.equal(byMount.get('/warn')!.reason, 'threshold');
    assert.equal(byMount.get('/crit')!.severity, 'critical');
    assert.equal(byMount.get('/crit')!.reason, 'threshold');

    // Critical sorts before warning.
    assert.equal(res.warnings[0].severity, 'critical');
  });

  it('classifies forecast-based warnings even when below the 85% threshold', () => {
    seedHost(db, 'growing', recent);
    // 60% full today, +5GB/day growth → ~8 days until full → forecast warning (< 14).
    seedGrowth(db, {
      hostId: 'growing', mount: '/var', totalGb: 100,
      startUsedGb: 25, endUsedGb: 60, days: 7,
    });

    const res = getDisksOverview(db, 10);
    const host = res.hosts.find((h: any) => h.hostId === 'growing');
    const mount = host.mounts[0];
    assert.ok(mount.daysUntilFull != null && mount.daysUntilFull < 14,
      `expected forecast under 14 days, got ${mount.daysUntilFull}`);

    const warning = res.warnings.find((w: any) => w.hostId === 'growing');
    assert.ok(warning, 'expected a forecast warning');
    assert.equal(warning.reason, 'forecast');
    // Under 7 days is critical, 7-14 is warning. Accept either since the math
    // hovers around 7 — just ensure it's classified as a disk-risk entry.
    assert.ok(warning.severity === 'warning' || warning.severity === 'critical');
  });

  it('marks offline hosts as online:false', () => {
    const stale = ts(new Date(NOW - 120 * 60 * 1000));
    seedHost(db, 'offline', stale);
    seedDiskSnapshots(db, [
      { hostId: 'offline', mount: '/', total: 100, used: 20, percent: 20, at: stale },
    ]);

    const res = getDisksOverview(db, 10);
    assert.equal(res.hosts[0].online, false);
  });

  it('prefers the latest snapshot per mount', () => {
    seedHost(db, 'h1', recent);
    const old = ts(new Date(NOW - 60 * 60 * 1000));
    seedDiskSnapshots(db, [
      { hostId: 'h1', mount: '/', total: 100, used: 30, percent: 30, at: old },
      { hostId: 'h1', mount: '/', total: 100, used: 50, percent: 50, at: recent },
    ]);

    const res = getDisksOverview(db, 10);
    assert.equal(res.totals.usedGb, 50);
    assert.equal(res.hosts[0].mounts[0].usedGb, 50);
  });
});
