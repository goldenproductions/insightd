# Disk-Fill ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Predict when a Linux disk mount or Proxmox storage pool will fill within 14 days, surface as a `prediction`-category insight.

**Architecture:** New module `hub/src/insights/disk-fill.ts` exposes `generateDiskFillInsights(db)`. It is called once per insights cycle from `generateInsights` in `detector.ts`, builds its own 12-column INSERT prepared statement (matching right-sizing), and reads `disk_snapshots`, `pve_storage_snapshots`, and `alert_state`. Trend math mirrors `computeMetricTrend` (daily averages over 7d, ≥4 days required, ≥1% relative growth, ≥half day-pairs consistent in direction).

**Tech Stack:** Node.js 20, TypeScript (strict), better-sqlite3, node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-05-10-disk-fill-eta-design.md`

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `hub/src/insights/disk-fill.ts` | create | Self-contained module: trend helper, disk-snapshots loop, pve-storage loop, alert-dedup query, `generateDiskFillInsights` export. ~150 lines. |
| `tests/unit/detector-disk-fill.test.ts` | create | TDD harness. Seeds raw snapshots, calls `generateInsights`, asserts on the `insights` table. ~300 lines. |
| `hub/src/insights/detector.ts` | modify | Add one require + one call inside `generateInsights` to wire `generateDiskFillInsights` into the cycle. |

No schema changes. No frontend changes (existing `InsightsPage.tsx` renders `prediction` insights with the 🔮 icon and severity grouping; the percent metric already routes to the percent formatter).

## Conventions to mirror

- **CommonJS exports** at the bottom: `module.exports = { generateDiskFillInsights };`. Match `proxmox-checks.ts` and `detector.ts` patterns. Caller in `detector.ts` will use `require('./disk-fill')`.
- **Local 12-column INSERT prepared statement** built inside the module — same as `generateRightSizingInsights` (`detector.ts:771-783`). The 10-column shared `insert` argument is unused; right-sizing accepts it as `_insert` for symmetry. Mirror that.
- **Test scaffolding:** `node:test` + `assert/strict`, `createTestDb()` from `tests/helpers/db`, `suppressConsole()` from `tests/helpers/mocks`. Schema bootstrap is automatic via `createTestDb`.
- **Insight inserts** go through the local prepared statement; the cycle-start `DELETE FROM insights` in `generateInsights` already clears prior rows, so the test only needs to call `generateInsights(db)` once and read the table back.

---

## Task 1: Create empty disk-fill module + wire into detector

**Files:**
- Create: `hub/src/insights/disk-fill.ts`
- Modify: `hub/src/insights/detector.ts` (one require, one call inside `generateInsights`)

**Why first:** Establishes the import wiring before any logic. After this task the module exists, exports a no-op, and is invoked each cycle. All later tasks add behavior + tests.

- [ ] **Step 1: Create `hub/src/insights/disk-fill.ts` with a no-op export**

```ts
/**
 * Disk-fill ETA predictions. One insight per (host, mount) or (host, storage)
 * that will reach saturation within 14 days at the current 7-day growth
 * rate. Sibling to right-sizing and proxmox-checks — runs from the
 * generateInsights cycle and writes into the shared `insights` table under
 * category 'prediction'.
 */
import type Database from 'better-sqlite3';

export function generateDiskFillInsights(db: Database.Database): number {
  void db;
  return 0;
}

module.exports = { generateDiskFillInsights };
```

- [ ] **Step 2: Wire the call into `generateInsights` in `detector.ts`**

Find the existing call site (around line 386):
```ts
  const { generateProxmoxInsights } = require('./proxmox-checks') as typeof import('./proxmox-checks');
  count += generateProxmoxInsights(db, insert);
```

Add immediately after it:
```ts
  const { generateDiskFillInsights } = require('./disk-fill') as typeof import('./disk-fill');
  count += generateDiskFillInsights(db);
```

(`generateDiskFillInsights` only takes `db` — the right-sizing-style local prepared statement is internal to the module, so no `insert` is passed.)

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: passes (no errors).

- [ ] **Step 4: Run existing test suite to confirm no regression**

Run: `npm test`
Expected: all existing tests pass. The new module is invoked but does nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/insights/disk-fill.ts hub/src/insights/detector.ts
git commit -m "scaffold disk-fill module + wire into generateInsights"
```

---

## Task 2: Add a daily-average trend helper + its unit test

**Files:**
- Create: `tests/unit/detector-disk-fill.test.ts`
- Modify: `hub/src/insights/disk-fill.ts`

The helper computes the same shape as `computeMetricTrend` but parameterized to read `total_gb`/`used_gb` from `disk_snapshots`. Returns `null` when the trend is too weak or noisy. Direct unit tests up-front make later tasks easier — they can build on a known-good trend primitive.

- [ ] **Step 1: Create the test file with the helper exposed for testing**

Add to `disk-fill.ts` a helper export so the test can call it directly:

```ts
export interface DailyAvg { day: string; avg: number }

/**
 * Compute a daily-averaged growth slope from rows already grouped by
 * day and ordered ascending by day. Returns null when the trend fails any
 * of the consistency / minimum-growth filters. Mirrors the rejection
 * conditions of detector.ts::computeMetricTrend.
 */
export function dailyTrend(
  daily: DailyAvg[],
  minAbsoluteGrowth: number,
): { current: number; dailyGrowth: number; dayCount: number } | null {
  if (daily.length < 4) return null;
  const first = daily[0]!.avg;
  const last = daily[daily.length - 1]!.avg;
  const days = daily.length - 1;
  const dailyGrowth = (last - first) / days;
  if (last > 0 && Math.abs(dailyGrowth / last) < 0.01) return null;
  if (Math.abs(dailyGrowth) < minAbsoluteGrowth) return null;
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < daily.length; i++) {
    const diff = daily[i]!.avg - daily[i - 1]!.avg;
    if (diff > 0) increasing++;
    else if (diff < 0) decreasing++;
  }
  if (dailyGrowth > 0 && increasing < Math.ceil(days / 2)) return null;
  if (dailyGrowth < 0 && decreasing < Math.ceil(days / 2)) return null;
  return { current: last, dailyGrowth, dayCount: daily.length };
}
```

Update bottom of file:
```ts
module.exports = { generateDiskFillInsights, dailyTrend };
```

- [ ] **Step 2: Write the unit test for `dailyTrend`**

Create `tests/unit/detector-disk-fill.test.ts`:

```ts
import { describe, it } from 'node:test';
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
      { day: 'd5', avg: 60 },  // last - first = 10, but only 1/4 pairs are increasing
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
```

- [ ] **Step 3: Run only this test file, expect green**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add hub/src/insights/disk-fill.ts tests/unit/detector-disk-fill.test.ts
git commit -m "add dailyTrend helper + unit tests"
```

---

## Task 3: Test scaffolding for end-to-end disk-fill insight assertions

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

Add a second `describe` block with seed/query helpers shared by all detector-level cases.

- [ ] **Step 1: Append the integration-test scaffolding**

Add to the test file, after the `describe('dailyTrend helper', …)` block:

```ts
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
});
```

Add these imports at the top of the file (next to existing ones):
```ts
import { beforeEach, afterEach } from 'node:test';
```

- [ ] **Step 2: Run the test file**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: PASS — 5 helper tests + 1 smoke test = 6 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add detector-disk-fill integration test scaffold"
```

---

## Task 4: Implement disk-snapshots path — warning case (TDD)

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts` (add failing test)
- Modify: `hub/src/insights/disk-fill.ts` (implement disk loop to make it pass)

- [ ] **Step 1: Add the failing warning-case test**

Inside the `describeIntegration('detector — disk-fill ETA insights', …)` block, append:

```ts
it('fires a warning insight when disk fills in 8 days at 5 GB/day on a 100 GB disk at 60%', () => {
  // 60 GB used today, growing 5 GB/day. Remaining = 40 GB → 8 days. Warning band.
  seedDisk({ totalGb: 100, startGb: 55, dailyGrowthGb: 5 / 6 * 6 / 6 });
  // The math: with 7 daily samples spanning days 0..6, last-first = 6 * dailyGrowth.
  // For dailyGrowth=5 we need startGb such that day-6 = 60. startGb = 60 - 5*6 = 30.
  // Reseed cleanly.
  db.prepare('DELETE FROM disk_snapshots').run();
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
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 1 test fails (`expected one disk-fill insight, got: []`). Helper tests + smoke test still pass.

- [ ] **Step 3: Implement the disk path**

Replace the body of `disk-fill.ts` with:

```ts
/**
 * Disk-fill ETA predictions. One insight per (host, mount) or (host, storage)
 * that will reach saturation within 14 days at the current 7-day growth
 * rate. Sibling to right-sizing and proxmox-checks — runs from the
 * generateInsights cycle and writes into the shared `insights` table under
 * category 'prediction'.
 */
import type Database from 'better-sqlite3';

const FLOOR_USED_PERCENT = 50;
const HORIZON_DAYS = 14;
const CRITICAL_DAYS = 3;
const MIN_DISK_GROWTH_GB = 0.05;       // 50 MB/day
const MIN_PVE_GROWTH_BYTES = 50 * 1024 * 1024; // 50 MB/day

export interface DailyAvg { day: string; avg: number }

export function dailyTrend(
  daily: DailyAvg[],
  minAbsoluteGrowth: number,
): { current: number; dailyGrowth: number; dayCount: number } | null {
  if (daily.length < 4) return null;
  const first = daily[0]!.avg;
  const last = daily[daily.length - 1]!.avg;
  const days = daily.length - 1;
  const dailyGrowth = (last - first) / days;
  if (last > 0 && Math.abs(dailyGrowth / last) < 0.01) return null;
  if (Math.abs(dailyGrowth) < minAbsoluteGrowth) return null;
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < daily.length; i++) {
    const diff = daily[i]!.avg - daily[i - 1]!.avg;
    if (diff > 0) increasing++;
    else if (diff < 0) decreasing++;
  }
  if (dailyGrowth > 0 && increasing < Math.ceil(days / 2)) return null;
  if (dailyGrowth < 0 && decreasing < Math.ceil(days / 2)) return null;
  return { current: last, dailyGrowth, dayCount: daily.length };
}

interface DiskRow { host_id: string; mount_point: string; total_gb: number; used_gb: number; used_percent: number }
interface DailyDiskRow { day: string; avg: number | null }

function generateDiskInsights(db: Database.Database, insert: ReturnType<Database.Database['prepare']>): number {
  let count = 0;
  // Latest snapshot per (host, mount).
  const latest = db.prepare(`
    SELECT host_id, mount_point, total_gb, used_gb, used_percent
    FROM disk_snapshots ds
    WHERE collected_at = (
      SELECT MAX(collected_at) FROM disk_snapshots
      WHERE host_id = ds.host_id AND mount_point = ds.mount_point
    )
  `).all() as DiskRow[];

  for (const row of latest) {
    if (!row.total_gb || row.total_gb <= 0) continue;
    if (row.used_percent < FLOOR_USED_PERCENT) continue;
    if (row.used_gb >= row.total_gb) continue;
    if (alertOpen(db, row.host_id, row.mount_point, 'disk_full')) continue;

    const daily = db.prepare(`
      SELECT DATE(collected_at) AS day, AVG(used_gb) AS avg
      FROM disk_snapshots
      WHERE host_id = ? AND mount_point = ?
        AND collected_at >= datetime('now', '-7 days')
      GROUP BY DATE(collected_at)
      ORDER BY day
    `).all(row.host_id, row.mount_point) as DailyDiskRow[];
    const cleaned = daily.filter((r): r is { day: string; avg: number } => r.avg != null);

    const trend = dailyTrend(cleaned, MIN_DISK_GROWTH_GB);
    if (!trend || trend.dailyGrowth <= 0) continue;

    const remainingGb = row.total_gb - trend.current;
    const daysUntil = Math.round(remainingGb / trend.dailyGrowth);
    if (daysUntil <= 0 || daysUntil > HORIZON_DAYS) continue;

    const severity: 'critical' | 'warning' = daysUntil <= CRITICAL_DAYS ? 'critical' : 'warning';
    const dayWord = daysUntil === 1 ? 'day' : 'days';
    const usedPct = round1((trend.current / row.total_gb) * 100);
    const evidence = JSON.stringify({
      mount_point: row.mount_point,
      used_gb: round1(trend.current),
      total_gb: round1(row.total_gb),
      daily_growth_gb: round2(trend.dailyGrowth),
      day_count: trend.dayCount,
    });

    insert.run(
      'host', row.host_id, 'prediction', severity,
      `Disk "${row.mount_point}" on ${row.host_id} filling up`,
      `${row.mount_point} at ${usedPct}% (${round1(trend.current)}/${round1(row.total_gb)} GB), growing ${round2(trend.dailyGrowth)} GB/day — full in ~${daysUntil} ${dayWord}`,
      'disk_used_percent', usedPct, 100, evidence,
      `Check largest consumers: \`du -h ${row.mount_point} | sort -h | tail -20\`. Common causes: log rotation broken, container volumes, package cache.`,
      'medium',
    );
    count++;
  }
  return count;
}

function alertOpen(db: Database.Database, hostId: string, target: string, alertType: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM alert_state
    WHERE alert_type = ? AND host_id = ? AND target = ? AND resolved_at IS NULL
    LIMIT 1
  `).get(alertType, hostId, target);
  return !!row;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

export function generateDiskFillInsights(db: Database.Database): number {
  const insert = db.prepare(`
    INSERT INTO insights
      (entity_type, entity_id, category, severity, title, message,
       metric, current_value, baseline_value, evidence,
       suggested_action, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  count += generateDiskInsights(db, insert);
  return count;
}

module.exports = { generateDiskFillInsights, dailyTrend };
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: all tests PASS (5 helper + smoke + warning case = 7).

- [ ] **Step 5: Commit**

```bash
git add hub/src/insights/disk-fill.ts tests/unit/detector-disk-fill.test.ts
git commit -m "implement disk-snapshots fill prediction (warning case)"
```

---

## Task 5: Severity branching + horizon + shrinking + flat (no-impl-change tests)

These tests exercise existing code paths. No implementation change expected; if any of them require code, the missing branch is in `generateDiskInsights`.

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

- [ ] **Step 1: Append the four cases**

Inside the integration `describe`, append:

```ts
it('fires critical when ETA <= 3 days', () => {
  // 60 GB used today (last day) with 20 GB/day growth ⇒ remaining 40 GB ⇒ 2 days.
  // Day 6 = 60 ⇒ startGb = 60 - 20*6 = -60. Use a smaller current to keep startGb non-negative.
  // Use total=100, startGb=0, dailyGrowth=10 → day 6 = 60 GB used (60%), remaining 40 → 4 days. That's still warning.
  // Bigger growth: total=100, startGb=10, dailyGrowth=10 → day 6 = 70 GB used, remaining 30 → 3 days. Critical at boundary.
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
```

- [ ] **Step 2: Run the file, expect all pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add severity / horizon / shrinking / flat tests for disk-fill"
```

---

## Task 6: Floor + insufficient-data cases

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

- [ ] **Step 1: Append**

```ts
it('does not fire when used_percent < 50% (floor)', () => {
  // 30 GB used, growing 5 GB/day, 100 GB total → ETA 14 days, but below floor.
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
```

- [ ] **Step 2: Run, expect pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add floor + insufficient-data tests for disk-fill"
```

---

## Task 7: Alert dedup test

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

- [ ] **Step 1: Append**

```ts
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
```

- [ ] **Step 2: Run, expect pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 15 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add alert dedup tests for disk-fill"
```

---

## Task 8: Multi-mount + evidence JSON shape

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

- [ ] **Step 1: Append**

```ts
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
```

- [ ] **Step 2: Run, expect pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 17 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add multi-mount + evidence-shape tests for disk-fill"
```

---

## Task 9: pve_storage path — TDD

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts` (add failing test)
- Modify: `hub/src/insights/disk-fill.ts` (add pve loop)

- [ ] **Step 1: Add failing pve warning case**

Inside the integration `describe`, append:

```ts
it('fires a warning insight on a pve_storage pool filling within horizon', () => {
  // 60 GB used today on 100 GB pool, growing 5 GB/day → 8 days.
  const GB = 1024 ** 3;
  seedPveStorage({
    storageName: 'local-zfs',
    totalBytes: 100 * GB,
    startBytes: 30 * GB,
    dailyGrowthBytes: 5 * GB,
  });
  generateInsights(db);
  const insights = getDiskFillInsights().filter(i => i.metric === 'pve_storage_used_percent');
  assert.equal(insights.length, 1);
  const i = insights[0]!;
  assert.equal(i.severity, 'warning');
  assert.match(i.title, /Storage pool "local-zfs" on node-1 filling up/);
  assert.match(i.suggested_action!, /pvesm status/);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 1 fail (no pve_storage insight produced).

- [ ] **Step 3: Implement the pve loop**

In `disk-fill.ts`, add (just above `generateDiskFillInsights`):

```ts
interface PveStorageRow { host_id: string; storage_name: string; storage_type: string; total_bytes: number; used_bytes: number; active: number }
interface DailyPveRow { day: string; avg: number | null }

function generatePveStorageInsights(db: Database.Database, insert: ReturnType<Database.Database['prepare']>): number {
  let count = 0;
  const latest = db.prepare(`
    SELECT host_id, storage_name, storage_type, total_bytes, used_bytes, active
    FROM pve_storage_snapshots ps
    WHERE collected_at = (
      SELECT MAX(collected_at) FROM pve_storage_snapshots
      WHERE host_id = ps.host_id AND storage_name = ps.storage_name
    )
  `).all() as PveStorageRow[];

  for (const row of latest) {
    if (!row.total_bytes || row.total_bytes <= 0) continue;
    if (!row.active) continue;
    const usedPct = (row.used_bytes / row.total_bytes) * 100;
    if (usedPct < FLOOR_USED_PERCENT) continue;
    if (row.used_bytes >= row.total_bytes) continue;
    if (alertOpen(db, row.host_id, row.storage_name, 'pve_storage_saturation')) continue;

    const daily = db.prepare(`
      SELECT DATE(collected_at) AS day, AVG(used_bytes) AS avg
      FROM pve_storage_snapshots
      WHERE host_id = ? AND storage_name = ?
        AND collected_at >= datetime('now', '-7 days')
      GROUP BY DATE(collected_at)
      ORDER BY day
    `).all(row.host_id, row.storage_name) as DailyPveRow[];
    const cleaned = daily.filter((r): r is { day: string; avg: number } => r.avg != null);

    const trend = dailyTrend(cleaned, MIN_PVE_GROWTH_BYTES);
    if (!trend || trend.dailyGrowth <= 0) continue;

    const remaining = row.total_bytes - trend.current;
    const daysUntil = Math.round(remaining / trend.dailyGrowth);
    if (daysUntil <= 0 || daysUntil > HORIZON_DAYS) continue;

    const severity: 'critical' | 'warning' = daysUntil <= CRITICAL_DAYS ? 'critical' : 'warning';
    const dayWord = daysUntil === 1 ? 'day' : 'days';
    const liveUsedPct = round1((trend.current / row.total_bytes) * 100);
    const evidence = JSON.stringify({
      storage_name: row.storage_name,
      storage_type: row.storage_type,
      used_bytes: Math.round(trend.current),
      total_bytes: row.total_bytes,
      daily_growth_bytes: Math.round(trend.dailyGrowth),
      day_count: trend.dayCount,
    });

    insert.run(
      'host', row.host_id, 'prediction', severity,
      `Storage pool "${row.storage_name}" on ${row.host_id} filling up`,
      `${row.storage_name} at ${liveUsedPct}% (${formatGb(trend.current)}/${formatGb(row.total_bytes)} GB), growing ${formatGb(trend.dailyGrowth)} GB/day — full in ~${daysUntil} ${dayWord}`,
      'pve_storage_used_percent', liveUsedPct, 100, evidence,
      `Inspect with \`pvesm status\` and review per-storage usage in Datacenter → Storage. Common causes: backups accumulating, disk images, ISO uploads.`,
      'medium',
    );
    count++;
  }
  return count;
}

function formatGb(bytes: number): string {
  return (bytes / (1024 ** 3)).toFixed(1);
}
```

Update `generateDiskFillInsights` to call both:
```ts
export function generateDiskFillInsights(db: Database.Database): number {
  const insert = db.prepare(`
    INSERT INTO insights
      (entity_type, entity_id, category, severity, title, message,
       metric, current_value, baseline_value, evidence,
       suggested_action, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  count += generateDiskInsights(db, insert);
  count += generatePveStorageInsights(db, insert);
  return count;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/insights/disk-fill.ts tests/unit/detector-disk-fill.test.ts
git commit -m "implement pve_storage fill prediction (warning case)"
```

---

## Task 10: pve_storage edge cases

**Files:**
- Modify: `tests/unit/detector-disk-fill.test.ts`

- [ ] **Step 1: Append**

```ts
it('skips pve_storage with active=0', () => {
  const GB = 1024 ** 3;
  seedPveStorage({
    storageName: 'mounted-offline',
    totalBytes: 100 * GB,
    startBytes: 30 * GB,
    dailyGrowthBytes: 5 * GB,
    active: 0,
  });
  generateInsights(db);
  const insights = getDiskFillInsights().filter(i => i.metric === 'pve_storage_used_percent');
  assert.equal(insights.length, 0);
});

it('dedups against open pve_storage_saturation alert', () => {
  const GB = 1024 ** 3;
  seedPveStorage({
    storageName: 'local-zfs',
    totalBytes: 100 * GB,
    startBytes: 30 * GB,
    dailyGrowthBytes: 5 * GB,
  });
  db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, message, trigger_value)
    VALUES ('node-1', 'pve_storage_saturation', 'local-zfs', datetime('now'), datetime('now'), 'storage saturated', '90')
  `).run();
  generateInsights(db);
  const insights = getDiskFillInsights().filter(i => i.metric === 'pve_storage_used_percent');
  assert.equal(insights.length, 0);
});

it('skips pve_storage with null total_bytes', () => {
  // active=1, but total_bytes is NULL — possible in real data when PVE hides
  // the storage size for inactive shared storage.
  db.prepare(`
    INSERT INTO pve_storage_snapshots (host_id, storage_name, storage_type, total_bytes, used_bytes, active, shared, collected_at)
    VALUES ('node-1', 'broken', 'dir', NULL, 60, 1, 0, datetime('now'))
  `).run();
  generateInsights(db);
  const insights = getDiskFillInsights().filter(i => i.metric === 'pve_storage_used_percent');
  assert.equal(insights.length, 0);
});
```

- [ ] **Step 2: Run, expect pass**

Run: `npx tsx --test tests/unit/detector-disk-fill.test.ts`
Expected: 21 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/detector-disk-fill.test.ts
git commit -m "add pve_storage edge case tests (active=0, dedup, null total)"
```

---

## Task 11: Final integration — full suite + typecheck + manual verification

**Files:**
- None (validation only)

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: all tests pass, including the 21 new disk-fill cases.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Manual verification on the live VM (vdev)**

Skip this step in CI / non-interactive environments. For the human running the implementation:

```bash
# from a machine that can SSH to the dev VM
ssh dev-vm
cd ~/insightd
git fetch origin && git checkout insights/disk-fill-eta
# Build + redeploy hub locally — see reference_insightd_ops.md memory for the
# exact "deploy" loop used in this repo (NOT a release).
docker compose build hub && docker compose up -d hub
# Wait for the hourly insights cycle (or trigger generateInsights manually
# via tsx — see the same memory).
sqlite3 /path/to/insightd.db \
  "SELECT entity_id, severity, title, message FROM insights
   WHERE category='prediction' AND metric LIKE '%disk%';"
```

Expected: zero or more rows on hosts where a real disk is filling. Inspect titles and messages for plausibility.

- [ ] **Step 4: No final commit needed**

All work was committed task-by-task. Branch `insights/disk-fill-eta` is ready for PR.

---

## Self-review

- **Spec coverage:** every spec requirement maps to a task.
  - 50% floor → Task 6 + impl in Task 4.
  - Alert dedup → Task 7 (disk) + Task 10 (pve).
  - Daily-average trend, 4-day minimum, consistency, growth thresholds → Task 2 (helper) + Task 5 (cases).
  - 14-day horizon, 3-day critical → Task 5.
  - disk_snapshots source → Task 4.
  - pve_storage_snapshots source → Task 9 + Task 10.
  - Insight payload shape (title, message, metric, evidence JSON, suggested_action, confidence) → Task 4 (disk), Task 9 (pve), Task 8 (evidence shape assertion).
  - Wipe-and-rewrite via existing detector cycle → Task 1 (wiring) + verified by all integration tests calling `generateInsights`.
  - Defensive null/zero total handling → Task 4 (impl) + Task 10 (pve null total test).

- **No placeholders:** all steps have exact paths, exact code, exact commands and expected outputs.

- **Type consistency:** `generateDiskFillInsights(db)` signature matches across Tasks 1, 4, 9, 11; helper exports (`dailyTrend`, `DailyAvg`) consistent between module and test imports; insert column count and ordering match across tasks.
