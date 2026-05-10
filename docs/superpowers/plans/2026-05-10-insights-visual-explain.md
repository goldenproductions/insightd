# Insights Visual + Explainable Drill-Down — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the inline expand of insight cards with a structured reason chain, a per-category chart, and a contributing-events timeline, served by one new lazy backend endpoint.

**Architecture:** New read-only endpoint `GET /api/insights/:id/explain` reads existing snapshot/alerts/events tables and returns a typed `InsightExplanation` (summary + chart + timeline). Frontend lazy-fetches it on expand and renders three new components. Recharts is added as a dynamic-import dependency so the initial bundle is unaffected.

**Tech Stack:** Node.js 20 / TypeScript (strict) / better-sqlite3 / `node:test` (backend); React 19 / TypeScript / TanStack Query v5 / Tailwind v4 / `recharts` (frontend, dynamic-imported).

**Spec:** `docs/superpowers/specs/2026-05-10-insights-visual-explain-design.md`

---

## File Structure

**Create:**
- `hub/src/insights/explain.ts` — `buildExplanation`, `buildSummary`, `buildChart`, `buildTimeline`
- `hub/src/insights/explain-types.ts` — `InsightExplanation` and sub-types (shared between backend + frontend through duplication, see notes)
- `tests/unit/insights-explain.test.ts` — unit tests for the three helpers
- `hub/src/web/frontend/src/components/insights/ReasonSummary.tsx`
- `hub/src/web/frontend/src/components/insights/InsightChart.tsx` (lazy-loaded entry)
- `hub/src/web/frontend/src/components/insights/ContributingTimeline.tsx`
- `hub/src/web/frontend/src/components/insights/charts/Sparkline.tsx`
- `hub/src/web/frontend/src/components/insights/charts/WeekOverlay.tsx`
- `hub/src/web/frontend/src/components/insights/charts/Forecast.tsx`
- `hub/src/web/frontend/src/components/insights/charts/UptimeBars.tsx`

**Modify:**
- `hub/src/insights/queries.ts` — add `getInsightById` (returns full row, including `evidence`/`suggested_action`/`confidence`)
- `hub/src/web/handlers.ts` — add `handleInsightExplain` and add to `module.exports`
- `hub/src/web/server.ts` — add route registration
- `hub/src/web/frontend/src/types/api.ts` — add `InsightExplanation` types
- `hub/src/web/frontend/src/lib/queryKeys.ts` — add `insightExplain(id)` key
- `hub/src/web/frontend/src/pages/InsightsPage.tsx` — rewrite expanded card body
- `hub/src/web/frontend/package.json` — add `recharts`

**Note on shared types:** the backend module is plain `module.exports` / `require` (CommonJS) per existing convention, the frontend is ESM. We don't share files across them — frontend types in `types/api.ts` are hand-mirrored from `explain.ts`. This is the existing pattern (see `InsightLogBurst`).

---

## Phase 0 — Setup

### Task 0.1: Branch + dependencies

**Files:**
- Modify: `hub/src/web/frontend/package.json`
- Modify: `hub/src/web/frontend/package-lock.json` (auto)

- [ ] **Step 1: Create feature branch**

```bash
cd /home/andreas/insightd
git checkout -b insights-visual-explain
```

- [ ] **Step 2: Add recharts to frontend**

```bash
cd hub/src/web/frontend
npm install recharts@^2.13
cd ../../../..
```

- [ ] **Step 3: Verify install**

```bash
node -e "console.log(require('./hub/src/web/frontend/node_modules/recharts/package.json').version)"
```

Expected: a `2.13.x` version string.

- [ ] **Step 4: Commit**

```bash
git add hub/src/web/frontend/package.json hub/src/web/frontend/package-lock.json
git commit -m "chore(frontend): add recharts for insight charts"
```

---

## Phase 1 — Backend: types + read query

### Task 1.1: Define `InsightExplanation` types

**Files:**
- Create: `hub/src/insights/explain-types.ts`

- [ ] **Step 1: Write the type module**

```ts
// hub/src/insights/explain-types.ts
//
// Shape of GET /api/insights/:id/explain response. Frontend mirrors these
// types in src/types/api.ts (hand-copied; no shared module across the CJS
// backend / ESM frontend boundary, matching the existing pattern).

export type ChartKind = 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars';

export interface ChartPoint {
  ts: string;     // ISO-ish "YYYY-MM-DD HH:MM:SS" (matches snapshot collected_at)
  value: number;
}

export interface ForecastPoint {
  ts: string;
  lower: number;
  upper: number;
  mid: number;
}

export interface UptimeInterval {
  from: string;
  to: string;
  up: boolean;
}

export interface ChartData {
  kind: ChartKind;
  points: ChartPoint[];
  compare?: ChartPoint[];
  forecast?: ForecastPoint[];
  uptime?: UptimeInterval[];
  threshold?: number;
  thresholdLabel?: string;
  yLabel?: string;
}

export type TimelineKind = 'log_burst' | 'alert_fired' | 'restart' | 'threshold_cross' | 'event';

export interface TimelineMarker {
  ts: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  severity?: 'critical' | 'warning' | 'info';
  href?: string;
}

export interface ExplanationSummary {
  lead: string;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface InsightExplanation {
  summary: ExplanationSummary;
  chart: ChartData;
  timeline: TimelineMarker[];
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/insights/explain-types.ts
git commit -m "feat(insights): explanation response types"
```

### Task 1.2: Extend `InsightRow` in queries.ts and add `getInsightById`

**Files:**
- Modify: `hub/src/insights/queries.ts`

- [ ] **Step 1: Replace the existing `InsightRow` interface with the full row**

Replace the existing `InsightRow` definition (lines 34-46 of `hub/src/insights/queries.ts`) with:

```ts
export interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  metric: string | null;
  current_value: number | null;
  baseline_value: number | null;
  evidence: string | null;
  suggested_action: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}
```

- [ ] **Step 2: Add `getInsightById` function**

Append before the `module.exports` line at the bottom of `hub/src/insights/queries.ts`:

```ts
function getInsightById(db: Database.Database, id: number): InsightRow | null {
  return db.prepare(`SELECT * FROM insights WHERE id = ?`).get(id) as InsightRow | undefined || null;
}
```

- [ ] **Step 3: Add `getInsightById` to module.exports**

Update the existing `module.exports` line at the bottom of the file to include `getInsightById`:

```ts
module.exports = { getBaselines, getBaselinesWithMad, getHostBaselines, getAllHealthScores, getHealthScore, getInsights, getEntityInsights, getHostInsights, getInsightById };
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/andreas/insightd
npm run typecheck
```

Expected: 0 errors. Note: existing call sites of `getInsights`/`getEntityInsights` still get the wider row, which only adds optional/nullable fields, so no consumers break.

- [ ] **Step 5: Commit**

```bash
git add hub/src/insights/queries.ts
git commit -m "feat(insights): widen InsightRow + add getInsightById"
```

---

## Phase 2 — Backend: explanation builders (TDD)

Each helper is built test-first with the smallest behavior at a time. The helpers are pure (DB in, plain object out) so they're cheap to unit-test.

### Task 2.1: Test scaffold for explain.ts

**Files:**
- Create: `tests/unit/insights-explain.test.ts`

- [ ] **Step 1: Write empty test file with shared seed helpers**

```ts
// tests/unit/insights-explain.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

// Module-under-test (loaded after each test creates its db so we can require fresh).
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

  it('placeholder', () => {
    assert.ok(db);
  });
});
```

- [ ] **Step 2: Run the empty suite**

```bash
cd /home/andreas/insightd
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `Cannot find module '../../hub/src/insights/explain'` (we haven't created it yet).

- [ ] **Step 3: Create empty `hub/src/insights/explain.ts`**

```ts
// hub/src/insights/explain.ts
import type Database from 'better-sqlite3';

module.exports = {};
```

- [ ] **Step 4: Re-run the suite**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS (1 passing — the placeholder).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "test(insights): scaffold explanation builder suite"
```

### Task 2.2: `buildSummary` — capacity-based synthesis

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Write a failing test for capacity-based summary**

Add inside the `describe('insights explain', ...)` block, replacing the placeholder test:

```ts
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
  });
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `explain.buildSummary is not a function`.

- [ ] **Step 3: Implement minimal `buildSummary`**

Replace the contents of `hub/src/insights/explain.ts` with:

```ts
// hub/src/insights/explain.ts
import type Database from 'better-sqlite3';

interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  metric: string | null;
  current_value: number | null;
  baseline_value: number | null;
  evidence: string | null;
  suggested_action: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}

interface ExplanationSummary {
  lead: string;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

function entityLabel(insight: InsightRow): string {
  // For "host/<container>" entity ids, use the container name; otherwise
  // the entity id is already user-meaningful (host id, disk mount, etc.)
  if (insight.entity_type === 'container' && insight.entity_id.includes('/')) {
    return insight.entity_id.split('/').slice(1).join('/');
  }
  return insight.entity_id;
}

function fmt(n: number | null, metric: string | null): string {
  if (n == null) return '-';
  if (metric?.includes('percent')) return `${Math.round(n * 10) / 10}%`;
  if (metric?.includes('mb') || metric?.includes('memory')) return `${Math.round(n)} MB`;
  return String(Math.round(n * 10) / 10);
}

function buildSummary(insight: InsightRow): ExplanationSummary {
  const lead = `${insight.title} on ${entityLabel(insight)}`;
  const reasons: string[] = [];
  if (insight.current_value != null) {
    reasons.push(`Current ${insight.metric ?? 'value'} is ${fmt(insight.current_value, insight.metric)}`);
  }
  if (insight.baseline_value != null) {
    reasons.push(`Baseline is ${fmt(insight.baseline_value, insight.metric)}`);
  }
  return { lead, reasons, confidence: insight.confidence };
}

module.exports = { buildSummary };
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): capacity-based summary synthesis"
```

### Task 2.3: `buildSummary` — diagnosis-engine evidence preserves order

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

Inside the `describe('buildSummary', ...)`:

```ts
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
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — diagnosis-evidence test gets synthesised reasons, not the parsed lines.

- [ ] **Step 3: Implement evidence parsing**

Edit `hub/src/insights/explain.ts`. Replace the body of `buildSummary` with:

```ts
function parseEvidenceLines(evidence: string | null): string[] | null {
  if (!evidence) return null;
  try {
    const parsed = JSON.parse(evidence);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === 'string');
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lines)) {
      return parsed.lines.filter((s: unknown): s is string => typeof s === 'string');
    }
    return null;
  } catch {
    return null;
  }
}

function buildSummary(insight: InsightRow): ExplanationSummary {
  const lead = `${insight.title} on ${entityLabel(insight)}`;
  const evidenceLines = parseEvidenceLines(insight.evidence);
  if (evidenceLines && evidenceLines.length > 0) {
    return { lead, reasons: evidenceLines.slice(0, 5), confidence: insight.confidence };
  }
  const reasons: string[] = [];
  if (insight.current_value != null) {
    reasons.push(`Current ${insight.metric ?? 'value'} is ${fmt(insight.current_value, insight.metric)}`);
  }
  if (insight.baseline_value != null) {
    reasons.push(`Baseline is ${fmt(insight.baseline_value, insight.metric)}`);
  }
  return { lead, reasons, confidence: insight.confidence };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): preserve diagnosis evidence order in summary"
```

### Task 2.4: `buildChart` — sparkline kind for performance/health/right_sizing

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

Add a new sub-`describe` inside `describe('insights explain', ...)`:

```ts
  describe('buildChart', () => {
    it('returns a sparkline for a performance host insight', () => {
      // Seed 24h of host snapshots
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
  });
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `explain.buildChart is not a function`.

- [ ] **Step 3: Implement `buildChart` for sparkline categories**

Append to `hub/src/insights/explain.ts` before `module.exports`:

```ts
type ChartKind = 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars';

interface ChartPoint { ts: string; value: number }

interface ChartData {
  kind: ChartKind;
  points: ChartPoint[];
  compare?: ChartPoint[];
  forecast?: { ts: string; lower: number; upper: number; mid: number }[];
  uptime?: { from: string; to: string; up: boolean }[];
  threshold?: number;
  thresholdLabel?: string;
  yLabel?: string;
}

function chartKindForCategory(category: string): ChartKind {
  switch (category) {
    case 'trend':        return 'week_overlay';
    case 'prediction':   return 'forecast';
    case 'availability': return 'uptime_bars';
    default:             return 'sparkline';
  }
}

function yLabelForMetric(metric: string | null): string | undefined {
  if (!metric) return undefined;
  if (metric.includes('percent')) return '%';
  if (metric.includes('mb') || metric.includes('memory')) return 'MB';
  if (metric.includes('load')) return 'load';
  return undefined;
}

function thresholdLabelForCategory(category: string): string | undefined {
  if (category === 'prediction') return 'Threshold (P90)';
  if (category === 'trend')      return 'Last week';
  if (category === 'availability') return 'Target';
  return 'Baseline (P95)';
}

function fetchHostMetricSeries(
  db: Database.Database, hostId: string, metric: string, fromIso: string, toIso: string,
): ChartPoint[] {
  // Map metric name → host_snapshots column. Only metrics we currently
  // surface for sparkline-style insights are mapped.
  const column = (() => {
    if (metric === 'host.cpu_percent')    return 'cpu_percent';
    if (metric === 'host.memory_percent') return null; // computed below
    if (metric === 'host.load_5')         return 'load_5';
    return null;
  })();
  if (metric === 'host.memory_percent') {
    return db.prepare(`
      SELECT collected_at AS ts,
             CASE WHEN memory_total_mb > 0 THEN (memory_used_mb * 100.0 / memory_total_mb) ELSE NULL END AS value
      FROM host_snapshots
      WHERE host_id = ? AND collected_at BETWEEN ? AND ?
      ORDER BY collected_at ASC
    `).all(hostId, fromIso, toIso) as ChartPoint[];
  }
  if (!column) return [];
  return db.prepare(`
    SELECT collected_at AS ts, ${column} AS value
    FROM host_snapshots
    WHERE host_id = ? AND collected_at BETWEEN ? AND ? AND ${column} IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, fromIso, toIso) as ChartPoint[];
}

function fetchContainerMetricSeries(
  db: Database.Database, entityId: string, metric: string, fromIso: string, toIso: string,
): ChartPoint[] {
  const [hostId, ...nameParts] = entityId.split('/');
  const containerName = nameParts.join('/');
  const column = (() => {
    if (metric === 'container.cpu_percent') return 'cpu_percent';
    if (metric === 'container.memory_mb')   return 'memory_mb';
    return null;
  })();
  if (!column) return [];
  return db.prepare(`
    SELECT collected_at AS ts, ${column} AS value
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ? AND collected_at BETWEEN ? AND ? AND ${column} IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, containerName, fromIso, toIso) as ChartPoint[];
}

function fetchSeries(
  db: Database.Database, insight: InsightRow, fromIso: string, toIso: string,
): ChartPoint[] {
  if (!insight.metric) return [];
  if (insight.entity_type === 'host') {
    return fetchHostMetricSeries(db, insight.entity_id, insight.metric, fromIso, toIso);
  }
  if (insight.entity_type === 'container') {
    return fetchContainerMetricSeries(db, insight.entity_id, insight.metric, fromIso, toIso);
  }
  return [];
}

function offsetIso(baseIso: string, hoursDelta: number): string {
  const t = new Date(baseIso.replace(' ', 'T') + 'Z');
  return tsAt(new Date(t.getTime() + hoursDelta * 60 * 60 * 1000));
}

// Local copy of the `tsAt` helper above. Keep it inside the same module so
// callers don't need to import test helpers.
function tsAt(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildChart(db: Database.Database, insight: InsightRow): ChartData {
  const kind = chartKindForCategory(insight.category);
  const yLabel = yLabelForMetric(insight.metric);
  const thresholdLabel = thresholdLabelForCategory(insight.category);
  const threshold = insight.baseline_value ?? undefined;

  if (kind === 'sparkline') {
    const fromIso = offsetIso(insight.computed_at, -24);
    const points = fetchSeries(db, insight, fromIso, insight.computed_at);
    return { kind, points, threshold, thresholdLabel, yLabel };
  }
  // Other kinds wired up in later tasks.
  return { kind, points: [], threshold, thresholdLabel, yLabel };
}
```

Update `module.exports` at the bottom:

```ts
module.exports = { buildSummary, buildChart };
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): sparkline chart data for performance/health/right_sizing"
```

### Task 2.5: `buildChart` — `week_overlay` for trend

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

Inside `describe('buildChart', ...)`:

```ts
    it('returns week_overlay with this-week + last-week series for trend', () => {
      const insertSnap = db.prepare(`
        INSERT INTO host_snapshots (host_id, cpu_percent, memory_total_mb, memory_used_mb, load_5, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      // Seed 14d of hourly data.
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
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `chart.points.length` is 0 because `week_overlay` branch is unimplemented.

- [ ] **Step 3: Implement week_overlay branch**

Edit `hub/src/insights/explain.ts`. Replace the bottom of `buildChart`:

```ts
  if (kind === 'sparkline') {
    const fromIso = offsetIso(insight.computed_at, -24);
    const points = fetchSeries(db, insight, fromIso, insight.computed_at);
    return { kind, points, threshold, thresholdLabel, yLabel };
  }
  if (kind === 'week_overlay') {
    const thisFrom = offsetIso(insight.computed_at, -24 * 7);
    const lastFrom = offsetIso(insight.computed_at, -24 * 14);
    const lastTo   = offsetIso(insight.computed_at, -24 * 7);
    const points  = fetchSeries(db, insight, thisFrom, insight.computed_at);
    const compare = fetchSeries(db, insight, lastFrom, lastTo);
    return { kind, points, compare, threshold, thresholdLabel, yLabel };
  }
  // Other kinds wired up in later tasks.
  return { kind, points: [], threshold, thresholdLabel, yLabel };
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): week_overlay chart data for trend insights"
```

### Task 2.6: `buildChart` — `forecast` for prediction (disk_fill)

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

```ts
    it('returns forecast cone for a disk_fill prediction insight', () => {
      // Seed 14d of disk snapshots.
      const insertDisk = db.prepare(`
        INSERT INTO disk_snapshots (host_id, mountpoint, total_bytes, used_bytes, percent, collected_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 14 * 24; i >= 0; i--) {
        const t = new Date(NOW.getTime() - i * 60 * 60 * 1000);
        const pct = 50 + (14 * 24 - i) * 0.05;
        insertDisk.run('h1', '/', 1_000_000_000, Math.round(pct * 1e7), pct, tsAt(t));
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
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `chart.forecast` is undefined.

- [ ] **Step 3: Implement forecast branch**

In `hub/src/insights/explain.ts`, add disk-snapshot fetcher just above `fetchSeries`:

```ts
function fetchDiskSeries(
  db: Database.Database, entityId: string, fromIso: string, toIso: string,
): ChartPoint[] {
  const [hostId, ...mountParts] = entityId.split('/');
  const mountpoint = '/' + mountParts.join('/');
  return db.prepare(`
    SELECT collected_at AS ts, percent AS value
    FROM disk_snapshots
    WHERE host_id = ? AND mountpoint = ? AND collected_at BETWEEN ? AND ? AND percent IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, mountpoint, fromIso, toIso) as ChartPoint[];
}
```

Update `fetchSeries` to dispatch on disk entities:

```ts
function fetchSeries(
  db: Database.Database, insight: InsightRow, fromIso: string, toIso: string,
): ChartPoint[] {
  if (insight.entity_type === 'host') {
    return fetchHostMetricSeries(db, insight.entity_id, insight.metric ?? '', fromIso, toIso);
  }
  if (insight.entity_type === 'container') {
    return fetchContainerMetricSeries(db, insight.entity_id, insight.metric ?? '', fromIso, toIso);
  }
  if (insight.entity_type === 'disk') {
    return fetchDiskSeries(db, insight.entity_id, fromIso, toIso);
  }
  return [];
}
```

Add a helper to read forecast metadata from `evidence`:

```ts
function parseForecastMeta(evidence: string | null): { horizon_hours: number; mid: number; lower: number; upper: number } | null {
  if (!evidence) return null;
  try {
    const parsed = JSON.parse(evidence);
    const f = parsed?.forecast;
    if (f && typeof f.horizon_hours === 'number' && typeof f.mid === 'number'
        && typeof f.lower === 'number' && typeof f.upper === 'number') {
      return f;
    }
  } catch { /* fall through */ }
  return null;
}
```

Add the forecast branch in `buildChart` (replace the trailing fallthrough):

```ts
  if (kind === 'forecast') {
    const fromIso = offsetIso(insight.computed_at, -24 * 14);
    const points = fetchSeries(db, insight, fromIso, insight.computed_at);
    const meta = parseForecastMeta(insight.evidence);
    let forecast: ChartData['forecast'] | undefined;
    if (meta) {
      const horizonHours = meta.horizon_hours;
      const stepHours = Math.max(1, Math.round(horizonHours / 24));
      const baselinePoint = points[points.length - 1]?.value ?? insight.current_value ?? meta.mid;
      forecast = [];
      for (let h = 0; h <= horizonHours; h += stepHours) {
        const ratio = h / horizonHours;
        const ts = offsetIso(insight.computed_at, h);
        forecast.push({
          ts,
          mid:   baselinePoint + (meta.mid   - baselinePoint) * ratio,
          lower: baselinePoint + (meta.lower - baselinePoint) * ratio,
          upper: baselinePoint + (meta.upper - baselinePoint) * ratio,
        });
      }
    }
    return { kind, points, forecast, threshold, thresholdLabel, yLabel };
  }
  // Other kinds wired up in later tasks.
  return { kind, points: [], threshold, thresholdLabel, yLabel };
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): forecast cone for prediction insights"
```

### Task 2.7: `buildChart` — `uptime_bars` for availability

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

```ts
    it('returns uptime_bars for an availability insight', () => {
      // Seed alert_state with one closed downtime + container_snapshots presence.
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
      assert.ok(chart.uptime!.some(iv => iv.up === false), 'expected at least one down interval');
    });
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — uptime is undefined.

- [ ] **Step 3: Implement uptime_bars branch**

In `hub/src/insights/explain.ts`, add this helper before `buildChart`:

```ts
function buildUptimeIntervals(
  db: Database.Database, entityId: string, fromIso: string, toIso: string,
): { from: string; to: string; up: boolean }[] {
  // Pull container_down alerts that overlap [fromIso, toIso] for the entity.
  const rows = db.prepare(`
    SELECT triggered_at AS triggered, COALESCE(resolved_at, ?) AS resolved
    FROM alert_state
    WHERE alert_type = 'container_down'
      AND target = ?
      AND triggered_at <= ?
      AND (resolved_at IS NULL OR resolved_at >= ?)
    ORDER BY triggered_at ASC
  `).all(toIso, entityId, toIso, fromIso) as { triggered: string; resolved: string }[];

  const intervals: { from: string; to: string; up: boolean }[] = [];
  let cursor = fromIso;
  for (const r of rows) {
    const downStart = r.triggered < fromIso ? fromIso : r.triggered;
    const downEnd   = r.resolved   > toIso   ? toIso   : r.resolved;
    if (cursor < downStart) intervals.push({ from: cursor, to: downStart, up: true });
    intervals.push({ from: downStart, to: downEnd, up: false });
    cursor = downEnd;
  }
  if (cursor < toIso) intervals.push({ from: cursor, to: toIso, up: true });
  return intervals;
}
```

Add an `uptime_bars` branch in `buildChart`, before the fallthrough `return`:

```ts
  if (kind === 'uptime_bars') {
    const fromIso = offsetIso(insight.computed_at, -24);
    const uptime = buildUptimeIntervals(db, insight.entity_id, fromIso, insight.computed_at);
    return { kind, points: [], uptime, thresholdLabel: 'Target' };
  }
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): uptime_bars chart data for availability"
```

### Task 2.8: `buildTimeline` — log bursts + alerts + restarts + threshold crossings

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

Add a new sub-`describe` inside `describe('insights explain', ...)`:

```ts
  describe('buildTimeline', () => {
    it('merges log bursts, alert fires, restart deltas, and threshold crossings, sorted oldest→newest, capped at 25', () => {
      // log bursts inside evidence
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
      // alert fires for entity
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, resolved_at)
        VALUES ('h1', 'container_high_cpu', 'h1/api', ?, NULL)
      `).run(tsAt(new Date(NOW.getTime() - 10 * 60 * 1000)));
      // container snapshot pair to detect a restart delta
      const insertSnap = db.prepare(`
        INSERT INTO container_snapshots
          (host_id, container_name, container_id, status, cpu_percent, restart_count, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertSnap.run('h1', 'api', 'abc', 'running', 50, 0, tsAt(new Date(NOW.getTime() - 60 * 60 * 1000)));
      insertSnap.run('h1', 'api', 'abc', 'running', 95, 1, tsAt(new Date(NOW.getTime() - 50 * 60 * 1000)));
      // chart points crossing threshold
      const points = [
        { ts: tsAt(new Date(NOW.getTime() - 40 * 60 * 1000)), value: 60 },
        { ts: tsAt(new Date(NOW.getTime() - 30 * 60 * 1000)), value: 80 },  // crossing 70
      ];

      const tl = explain.buildTimeline(db, insight, points);

      const kinds = tl.map((m: any) => m.kind);
      assert.ok(kinds.includes('log_burst'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('alert_fired'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('restart'), `kinds=${kinds.join(',')}`);
      assert.ok(kinds.includes('threshold_cross'), `kinds=${kinds.join(',')}`);
      // sorted ascending
      const tsList = tl.map((m: any) => m.ts);
      assert.deepEqual([...tsList].sort(), tsList);
      // cap respected
      assert.ok(tl.length <= 25, `cap exceeded: ${tl.length}`);
    });
  });
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `explain.buildTimeline is not a function`.

- [ ] **Step 3: Implement `buildTimeline`**

Append to `hub/src/insights/explain.ts`:

```ts
type TimelineKind = 'log_burst' | 'alert_fired' | 'restart' | 'threshold_cross' | 'event';

interface TimelineMarker {
  ts: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  severity?: 'critical' | 'warning' | 'info';
  href?: string;
}

function parseLogBursts(evidence: string | null): { ts: string; template: string; semantic_tag: string | null; batch_count: number }[] {
  if (!evidence) return [];
  try {
    const p = JSON.parse(evidence);
    if (p && typeof p === 'object' && Array.isArray(p.log_bursts)) return p.log_bursts;
  } catch { /* ignore */ }
  return [];
}

function fetchAlertFires(db: Database.Database, target: string, fromIso: string, toIso: string) {
  return db.prepare(`
    SELECT alert_type, triggered_at AS ts
    FROM alert_state
    WHERE target = ? AND triggered_at BETWEEN ? AND ?
    ORDER BY triggered_at ASC
  `).all(target, fromIso, toIso) as { alert_type: string; ts: string }[];
}

function fetchContainerRestartDeltas(
  db: Database.Database, hostId: string, containerName: string, fromIso: string, toIso: string,
): { ts: string; delta: number }[] {
  const rows = db.prepare(`
    SELECT collected_at AS ts, restart_count
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ? AND collected_at BETWEEN ? AND ?
    ORDER BY collected_at ASC
  `).all(hostId, containerName, fromIso, toIso) as { ts: string; restart_count: number }[];
  const out: { ts: string; delta: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].restart_count - rows[i - 1].restart_count;
    if (delta > 0) out.push({ ts: rows[i].ts, delta });
  }
  return out;
}

function thresholdCrossings(points: ChartPoint[], threshold: number | undefined): ChartPoint[] {
  if (threshold == null || points.length < 2) return [];
  const out: ChartPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    const curr = points[i].value;
    if ((prev <= threshold && curr > threshold) || (prev >= threshold && curr < threshold)) {
      out.push(points[i]);
    }
  }
  return out;
}

function buildTimeline(
  db: Database.Database, insight: InsightRow, chartPoints: ChartPoint[],
): TimelineMarker[] {
  const fromIso = offsetIso(insight.computed_at, -24);
  const toIso = insight.computed_at;
  const markers: TimelineMarker[] = [];

  for (const b of parseLogBursts(insight.evidence)) {
    markers.push({
      ts: b.ts, kind: 'log_burst',
      label: b.semantic_tag ?? 'Log spike',
      detail: `${b.template} ×${b.batch_count}`,
      severity: 'warning',
    });
  }
  for (const a of fetchAlertFires(db, insight.entity_id, fromIso, toIso)) {
    markers.push({ ts: a.ts, kind: 'alert_fired', label: a.alert_type, severity: 'critical' });
  }
  if (insight.entity_type === 'container') {
    const [hostId, ...rest] = insight.entity_id.split('/');
    const containerName = rest.join('/');
    for (const r of fetchContainerRestartDeltas(db, hostId, containerName, fromIso, toIso)) {
      markers.push({ ts: r.ts, kind: 'restart', label: `+${r.delta} restart${r.delta > 1 ? 's' : ''}`, severity: 'warning' });
    }
  }
  for (const c of thresholdCrossings(chartPoints, insight.baseline_value ?? undefined)) {
    markers.push({ ts: c.ts, kind: 'threshold_cross', label: 'Crossed threshold', severity: 'info' });
  }

  markers.sort((a, b) => a.ts.localeCompare(b.ts));
  // Cap at 25, drop the oldest first so the most recent context wins.
  return markers.length > 25 ? markers.slice(markers.length - 25) : markers;
}
```

Update `module.exports`:

```ts
module.exports = { buildSummary, buildChart, buildTimeline };
```

- [ ] **Step 4: Run, verify pass**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): timeline of contributing events"
```

### Task 2.9: `buildExplanation` orchestrator

**Files:**
- Modify: `tests/unit/insights-explain.test.ts`
- Modify: `hub/src/insights/explain.ts`

- [ ] **Step 1: Add failing test**

Inside `describe('insights explain', ...)`:

```ts
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
```

- [ ] **Step 2: Run, verify failure**

```bash
npx tsx --test tests/unit/insights-explain.test.ts
```

Expected: FAIL — `explain.buildExplanation is not a function`.

- [ ] **Step 3: Implement orchestrator**

Append to `hub/src/insights/explain.ts`:

```ts
function buildExplanation(db: Database.Database, insight: InsightRow) {
  const summary  = buildSummary(insight);
  const chart    = buildChart(db, insight);
  const timeline = buildTimeline(db, insight, chart.points);
  return { summary, chart, timeline };
}
```

Update `module.exports`:

```ts
module.exports = { buildSummary, buildChart, buildTimeline, buildExplanation };
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: PASS (full suite, including the new explanation suite).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/insights-explain.test.ts hub/src/insights/explain.ts
git commit -m "feat(insights): buildExplanation orchestrator"
```

---

## Phase 3 — Backend: HTTP wiring

### Task 3.1: `handleInsightExplain` handler

**Files:**
- Modify: `hub/src/web/handlers.ts`

- [ ] **Step 1: Add the handler**

Open `hub/src/web/handlers.ts`. Find the `handleGetInsights` function near line 1149. Immediately after it (and before `handleGetHostInsights`), add:

```ts
function handleInsightExplain(req: HandlerReq, res: ServerResponse, db: Database.Database, _config: any, params: Record<string, string>): any {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) {
    res.statusCode = 400;
    return { error: 'invalid insight id' };
  }
  const insight = insightQueries.getInsightById(db, id);
  if (!insight) {
    res.statusCode = 404;
    return { error: 'insight not found' };
  }
  const explain = require('../insights/explain');
  return explain.buildExplanation(db, insight);
}
```

- [ ] **Step 2: Add the handler to `module.exports`**

At the bottom of `handlers.ts` (the long `module.exports = { ... }` block near line 1629), add `handleInsightExplain` to the list.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add hub/src/web/handlers.ts
git commit -m "feat(web): handleInsightExplain handler"
```

### Task 3.2: Register route

**Files:**
- Modify: `hub/src/web/server.ts`

- [ ] **Step 1: Add route registration**

Open `hub/src/web/server.ts`. Near the existing line `router.add('GET', '/api/hosts/:hostId/timeline', handlers.handleTimeline);` (around line 86), add a new line under the insight routes — find an appropriate spot near `handleGetInsights`/`handleGetHostInsights`. If those routes aren't already registered there, search the file for `handleGetInsights` and add after that line:

```ts
router.add('GET', '/api/insights/:id/explain', handlers.handleInsightExplain);
```

- [ ] **Step 2: Verify route is reachable via curl**

Start the hub locally (or rely on the integration tests in step 3). Then:

```bash
# (optional manual probe; integration test below covers the same)
curl -sS http://localhost:3000/api/insights/1/explain
```

Expected: JSON `{ summary, chart, timeline }` for a real insight, or `{"error":"insight not found"}` for an unknown id, or 401 if auth is required by the local config.

- [ ] **Step 3: Add integration test**

Open `tests/integration/web-api.test.ts`. Find an existing insight-related test (`describe('insights endpoints', ...)` or similar). Add a test inside that describe (or a new describe near it):

```ts
  it('GET /api/insights/:id/explain returns 404 for unknown id and 200 for known id', async () => {
    // assumes the existing test bootstrap seeds at least one insight; if not,
    // seed one inline via the same helper this file already uses.
    const unknown = await fetch(`${baseUrl}/api/insights/99999/explain`, { headers: authHeaders });
    assert.equal(unknown.status, 404);

    const list = await (await fetch(`${baseUrl}/api/insights`, { headers: authHeaders })).json();
    assert.ok(Array.isArray(list) && list.length > 0, 'expected at least one insight in list response');
    const id = list[0].id;
    const ok = await fetch(`${baseUrl}/api/insights/${id}/explain`, { headers: authHeaders });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.summary && body.chart && Array.isArray(body.timeline));
  });
```

If `tests/integration/web-api.test.ts` does not have a list-of-insights bootstrap, copy the seed pattern from a neighbouring `it()` block — keep it minimal, one insight is enough.

- [ ] **Step 4: Run integration test**

```bash
npx tsx --test tests/integration/web-api.test.ts
```

Expected: PASS, including the new test.

- [ ] **Step 5: Commit**

```bash
git add hub/src/web/server.ts tests/integration/web-api.test.ts
git commit -m "feat(web): wire /api/insights/:id/explain route"
```

---

## Phase 4 — Frontend: types + queryKeys

### Task 4.1: Mirror types into `types/api.ts`

**Files:**
- Modify: `hub/src/web/frontend/src/types/api.ts`

- [ ] **Step 1: Find the `InsightRow` block (around line 1086) and append the new types after it**

```ts
// hub/src/web/frontend/src/types/api.ts (append after InsightRow / InsightFeedback)

export type ChartKind = 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars';

export interface ExplainChartPoint {
  ts: string;
  value: number;
}

export interface ExplainForecastPoint {
  ts: string;
  lower: number;
  upper: number;
  mid: number;
}

export interface ExplainUptimeInterval {
  from: string;
  to: string;
  up: boolean;
}

export interface ExplainChart {
  kind: ChartKind;
  points: ExplainChartPoint[];
  compare?: ExplainChartPoint[];
  forecast?: ExplainForecastPoint[];
  uptime?: ExplainUptimeInterval[];
  threshold?: number;
  thresholdLabel?: string;
  yLabel?: string;
}

export type TimelineKind = 'log_burst' | 'alert_fired' | 'restart' | 'threshold_cross' | 'event';

export interface ExplainTimelineMarker {
  ts: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  severity?: 'critical' | 'warning' | 'info';
  href?: string;
}

export interface ExplainSummary {
  lead: string;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface InsightExplanation {
  summary: ExplainSummary;
  chart: ExplainChart;
  timeline: ExplainTimelineMarker[];
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/web/frontend/src/types/api.ts
git commit -m "feat(frontend): InsightExplanation types"
```

### Task 4.2: Add queryKey

**Files:**
- Modify: `hub/src/web/frontend/src/lib/queryKeys.ts`

- [ ] **Step 1: Add the key**

Open `hub/src/web/frontend/src/lib/queryKeys.ts`. Find the existing `insights:` factory entry. Add a sibling:

```ts
  insightExplain: (id: number) => ['insightExplain', id] as const,
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/web/frontend/src/lib/queryKeys.ts
git commit -m "feat(frontend): insightExplain query key"
```

---

## Phase 5 — Frontend: components

### Task 5.1: `ReasonSummary`

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/ReasonSummary.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/ReasonSummary.tsx
import { Badge } from '@/components/Badge';
import type { ExplainSummary } from '@/types/api';

const CONFIDENCE_COLOR: Record<NonNullable<ExplainSummary['confidence']>, string> = {
  high: 'green',
  medium: 'yellow',
  low: 'gray',
};

export function ReasonSummary({ summary }: { summary: ExplainSummary }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-fg">{summary.lead}</h4>
        {summary.confidence && (
          <Badge text={`${summary.confidence} confidence`} color={CONFIDENCE_COLOR[summary.confidence]} />
        )}
      </div>
      {summary.reasons.length > 0 && (
        <ol className="space-y-1 pl-1">
          {summary.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-secondary">
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg text-[10px] font-semibold tabular-nums text-muted">
                {i + 1}
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/ReasonSummary.tsx
git commit -m "feat(frontend): ReasonSummary component"
```

### Task 5.2: `Sparkline` chart

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/charts/Sparkline.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/charts/Sparkline.tsx
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function Sparkline({ chart }: { chart: ExplainChart }) {
  if (chart.points.length === 0) {
    return <div className="text-xs text-muted">No metric history yet for this entity.</div>;
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={chart.points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="var(--info)" dot={false} strokeWidth={2} />
          {chart.threshold != null && (
            <ReferenceLine
              y={chart.threshold}
              stroke="var(--danger)"
              strokeDasharray="4 4"
              label={{ value: chart.thresholdLabel ?? 'Threshold', fill: 'var(--danger)', fontSize: 10, position: 'right' }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/charts/Sparkline.tsx
git commit -m "feat(frontend): Sparkline chart"
```

### Task 5.3: `WeekOverlay` chart

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/charts/WeekOverlay.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/charts/WeekOverlay.tsx
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function WeekOverlay({ chart }: { chart: ExplainChart }) {
  // Align last week's points onto this week's x-axis by shifting timestamps +7d.
  const SHIFT_MS = 7 * 24 * 60 * 60 * 1000;
  const compareShifted = (chart.compare ?? []).map(p => ({
    ts: new Date(new Date(p.ts.replace(' ', 'T') + 'Z').getTime() + SHIFT_MS).toISOString(),
    last: p.value,
  }));
  // Merge by timestamp into one record per row for recharts.
  const byTs = new Map<string, { ts: string; current?: number; last?: number }>();
  for (const p of chart.points)        byTs.set(p.ts,  { ts: p.ts,  current: p.value });
  for (const p of compareShifted)      byTs.set(p.ts,  { ...(byTs.get(p.ts) ?? { ts: p.ts }), last: p.last });
  const data = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="current" stroke="var(--info)"   dot={false} strokeWidth={2} name="This week" />
          <Line type="monotone" dataKey="last"    stroke="var(--muted)"  dot={false} strokeDasharray="4 4" name="Last week" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/charts/WeekOverlay.tsx
git commit -m "feat(frontend): WeekOverlay chart"
```

### Task 5.4: `Forecast` chart

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/charts/Forecast.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/charts/Forecast.tsx
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function Forecast({ chart }: { chart: ExplainChart }) {
  type Row = { ts: string; history?: number; mid?: number; cone?: [number, number] };
  const rows: Row[] = [];
  for (const p of chart.points) rows.push({ ts: p.ts, history: p.value });
  for (const f of chart.forecast ?? []) {
    rows.push({ ts: f.ts, mid: f.mid, cone: [f.lower, f.upper] });
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Area type="monotone" dataKey="cone" stroke="none" fill="var(--info)" fillOpacity={0.15} />
          <Line type="monotone" dataKey="history" stroke="var(--info)"    dot={false} strokeWidth={2} name="History" />
          <Line type="monotone" dataKey="mid"     stroke="var(--warning)" dot={false} strokeDasharray="4 4" name="Forecast" />
          {chart.threshold != null && (
            <ReferenceLine y={chart.threshold} stroke="var(--danger)" strokeDasharray="4 4"
              label={{ value: chart.thresholdLabel ?? 'Threshold', fill: 'var(--danger)', fontSize: 10, position: 'right' }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/charts/Forecast.tsx
git commit -m "feat(frontend): Forecast chart"
```

### Task 5.5: `UptimeBars` chart

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/charts/UptimeBars.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/charts/UptimeBars.tsx
import type { ExplainChart } from '@/types/api';

export function UptimeBars({ chart }: { chart: ExplainChart }) {
  const intervals = chart.uptime ?? [];
  if (intervals.length === 0) {
    return <div className="text-xs text-muted">No uptime data for this window.</div>;
  }
  // Compute total span for proportional widths.
  const startMs = new Date(intervals[0].from.replace(' ', 'T') + 'Z').getTime();
  const endMs   = new Date(intervals[intervals.length - 1].to.replace(' ', 'T') + 'Z').getTime();
  const span = Math.max(1, endMs - startMs);

  return (
    <div className="space-y-2">
      <div className="flex h-6 w-full overflow-hidden rounded">
        {intervals.map((iv, i) => {
          const a = new Date(iv.from.replace(' ', 'T') + 'Z').getTime();
          const b = new Date(iv.to.replace(' ', 'T') + 'Z').getTime();
          const widthPct = ((b - a) / span) * 100;
          return (
            <div
              key={i}
              title={`${iv.up ? 'Up' : 'Down'}: ${iv.from} → ${iv.to}`}
              className={iv.up ? 'bg-success' : 'bg-danger'}
              style={{ width: `${widthPct}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{intervals[0].from}</span>
        <span>{intervals[intervals.length - 1].to}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/charts/UptimeBars.tsx
git commit -m "feat(frontend): UptimeBars chart"
```

### Task 5.6: `InsightChart` dispatcher (lazy entry)

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/InsightChart.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/InsightChart.tsx
//
// This module is the single dynamic-import entry point for chart code.
// `InsightsPage.tsx` lazy-loads it, which means recharts only enters the
// bundle on first card expansion.

import type { ExplainChart } from '@/types/api';
import { Sparkline } from './charts/Sparkline';
import { WeekOverlay } from './charts/WeekOverlay';
import { Forecast } from './charts/Forecast';
import { UptimeBars } from './charts/UptimeBars';

export default function InsightChart({ chart }: { chart: ExplainChart }) {
  switch (chart.kind) {
    case 'sparkline':    return <Sparkline   chart={chart} />;
    case 'week_overlay': return <WeekOverlay chart={chart} />;
    case 'forecast':     return <Forecast    chart={chart} />;
    case 'uptime_bars':  return <UptimeBars  chart={chart} />;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/InsightChart.tsx
git commit -m "feat(frontend): InsightChart dispatcher (lazy entry)"
```

### Task 5.7: `ContributingTimeline`

**Files:**
- Create: `hub/src/web/frontend/src/components/insights/ContributingTimeline.tsx`

- [ ] **Step 1: Implement**

```tsx
// hub/src/web/frontend/src/components/insights/ContributingTimeline.tsx
import type { ExplainTimelineMarker } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

const KIND_DOT_COLOR: Record<ExplainTimelineMarker['kind'], string> = {
  log_burst:       'bg-warning',
  alert_fired:     'bg-danger',
  restart:         'bg-warning',
  threshold_cross: 'bg-info',
  event:           'bg-muted',
};

export function ContributingTimeline({ events }: { events: ExplainTimelineMarker[] }) {
  if (events.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">Contributing events</div>
      <ul className="mt-2 space-y-1.5">
        {events.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${KIND_DOT_COLOR[e.kind]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg">{e.label}</span>
                <span className="text-muted" title={e.ts}>{timeAgo(e.ts)}</span>
              </div>
              {e.detail && <div className="truncate font-mono text-[11px] text-secondary">{e.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/web/frontend/src/components/insights/ContributingTimeline.tsx
git commit -m "feat(frontend): ContributingTimeline component"
```

---

## Phase 6 — Frontend: rewire `InsightsPage.tsx`

### Task 6.1: Replace expanded card body

**Files:**
- Modify: `hub/src/web/frontend/src/pages/InsightsPage.tsx`

- [ ] **Step 1: Add imports at the top (after the existing imports)**

```tsx
import React, { Suspense, useState } from 'react';
import { ReasonSummary } from '@/components/insights/ReasonSummary';
import { ContributingTimeline } from '@/components/insights/ContributingTimeline';
import type { InsightExplanation } from '@/types/api';
const InsightChart = React.lazy(() => import('@/components/insights/InsightChart'));
```

(If `useState` is already imported, just merge `Suspense` into the existing React import.)

- [ ] **Step 2: Replace the body of `InsightCard`**

Find the `InsightCard` function (currently lines 141-250). Inside the `{isExpanded && (...)}` block, replace the entire current contents (the stats grid + co-occurring logs) with a fetch + render pipeline:

```tsx
      {isExpanded && <ExpandedBody insight={insight} />}
```

Then add a new component immediately below `InsightCard`:

```tsx
function ExpandedBody({ insight }: { insight: InsightRow }) {
  const { data: explain, isError } = useQuery({
    queryKey: queryKeys.insightExplain(insight.id),
    queryFn: () => api<InsightExplanation>(`/insights/${insight.id}/explain`),
    staleTime: 60_000,
  });

  if (isError) return <FallbackStats insight={insight} />;
  if (!explain) return (
    <div className="border-t border-border px-4 py-3">
      <CardSkeleton lines={4} />
    </div>
  );

  return (
    <div className="space-y-4 border-t border-border px-4 py-3">
      <ReasonSummary summary={explain.summary} />
      <Suspense fallback={<CardSkeleton lines={3} />}>
        <InsightChart chart={explain.chart} />
      </Suspense>
      <ContributingTimeline events={explain.timeline} />
      <MetadataRow insight={insight} />
    </div>
  );
}
```

- [ ] **Step 3: Add `MetadataRow` and `FallbackStats` helpers below `ExpandedBody`**

```tsx
function MetadataRow({ insight }: { insight: InsightRow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-xs text-muted">
      <Link to={entityLink(insight)} className="text-info hover:underline">
        {entityName(insight)} <span className="text-muted">({insight.entity_type})</span>
      </Link>
      {insight.metric && <span>Metric: <span className="font-mono">{insight.metric}</span></span>}
      <span>Computed {timeAgo(insight.computed_at)}</span>
    </div>
  );
}

function FallbackStats({ insight }: { insight: InsightRow }) {
  // Pre-rebuild stats grid kept here as a graceful-degrade for /explain failures.
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {insight.current_value != null && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Current</div>
            <div className="mt-0.5 text-lg font-bold text-fg">
              {formatMetricValue(insight.current_value, insight.metric)}
            </div>
          </div>
        )}
        {insight.baseline_value != null && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Baseline</div>
            <div className="mt-0.5 text-lg font-bold text-secondary">
              {formatMetricValue(insight.baseline_value, insight.metric)}
            </div>
          </div>
        )}
        <MetadataRow insight={insight} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Remove the unused `CoOccurringLogs` block, plus the now-unused `formatIntensity`, `truncate`, `BURST_TAG_LABELS`, `BURST_TAG_COLORS` constants from `InsightsPage.tsx`. (Co-occurring logs render through the timeline now.)**

Verify with grep:

```bash
grep -n "CoOccurringLogs\|BURST_TAG_LABELS\|formatIntensity" hub/src/web/frontend/src/pages/InsightsPage.tsx
```

Expected: no matches.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: SUCCESS. Note the output sizes — the recharts chunk should appear in a separate `assets/` chunk (a name like `InsightChart-*.js`). Initial bundle should be unchanged or near it.

- [ ] **Step 7: Commit**

```bash
git add hub/src/web/frontend/src/pages/InsightsPage.tsx
git commit -m "feat(frontend): rebuilt insight expand with reasoning + chart + timeline"
```

---

## Phase 7 — Verification + rollout

### Task 7.1: Full test + typecheck + build

- [ ] **Step 1: Run the full backend test suite**

```bash
npm test
```

Expected: PASS, including new unit + integration tests.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Build frontend**

```bash
npm run build
```

Expected: SUCCESS. Confirm `recharts` is in a code-split chunk by `grep -l recharts hub/src/web/frontend/dist/assets/*.js` listing only one or two files (the lazy chunks for `InsightChart`).

### Task 7.2: Manual UI test on dev VM

- [ ] **Step 1: Build images and push to dev VM**

Follow the existing dev VM deploy loop (per `memory/reference_insightd_ops.md`).

- [ ] **Step 2: Open `/insights` and verify each chart kind renders**

Open one insight per category and confirm:
- performance / health / right_sizing → sparkline with threshold line.
- trend → two lines (this week, last week).
- prediction → history + forecast cone + threshold.
- availability → green/red bar segments.

- [ ] **Step 3: Verify network behavior in DevTools**

- `/api/insights/:id/explain` is requested only on first expand.
- Re-expand within `staleTime` does not refetch.
- Initial page load does not request any explain endpoint.

### Task 7.3: Open PR

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin insights-visual-explain
gh pr create --title "Visual + explainable drill-down for insights" --body "$(cat <<'EOF'
## Summary
- New `/api/insights/:id/explain` endpoint returns structured summary + per-category chart data + contributing-events timeline
- Inline expand on the Insights page now renders a reasoning chain, a category-appropriate chart (sparkline / week overlay / forecast cone / uptime bars), and a contributing-events timeline
- Recharts added as a dynamic-imported dependency (initial bundle unchanged)

## Test plan
- [ ] `npm test` (incl. new `tests/unit/insights-explain.test.ts` + extended `tests/integration/web-api.test.ts`)
- [ ] `npm run typecheck`
- [ ] `npm run build` (verify recharts is code-split)
- [ ] Manual: expand one insight per category on dev VM; confirm chart kind matches
- [ ] Manual: confirm `/explain` is fetched only on first expand

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Verify CI green**

```bash
gh pr checks
```

Expected: All checks pass.

### Task 7.4: Post-merge memory update

- [ ] **Step 1: After merge, update `memory/project_insightd.md` index entry to mention the new endpoint and UI shift (per the `feedback_post_merge_memory.md` rule).**

Add or update the bullet for the latest insightd PR with:

```
PR #<n> Visual+explainable insights drill-down — /api/insights/:id/explain, per-category charts (recharts dynamic-imported), contributing-events timeline, ReasonSummary
```

---

## Self-Review Notes

**Spec coverage check:**
- Reason summary → Tasks 2.2, 2.3, 5.1, 6.1
- Per-category chart → Tasks 2.4–2.7, 5.2–5.6
- Contributing timeline → Tasks 2.8, 5.7, 6.1
- Single explain endpoint, lazy-fetched → Tasks 1.2, 2.9, 3.1, 3.2, 6.1
- Recharts dynamic-imported → Task 0.1, 5.6, 6.1, 7.1
- Window math per category (24h / 7d×2 / 14d / 24h) → Tasks 2.4–2.7
- Failure modes (404, empty points, lazy-load fail) → Task 6.1 `FallbackStats`
- Tests — backend unit + integration → Phases 2 + 3
- Out-of-scope items left out (caching, dedicated route, feedback re-enable, cross-entity overlays) — none implemented in this plan ✓

**Type/method consistency check:**
- `buildSummary` / `buildChart` / `buildTimeline` / `buildExplanation` referenced consistently across tasks.
- Frontend `InsightExplanation` field names (`summary` / `chart` / `timeline`) match backend types.
- `chart.kind` values match across backend (`explain.ts`) and frontend (`InsightChart.tsx`).
- `getInsightById` exported in Task 1.2 and consumed in Task 3.1.
- `queryKeys.insightExplain` defined in Task 4.2 and consumed in Task 6.1.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "appropriate error handling" remain. The only TODO references in the file are inside the `out of scope / follow-ups` section, which is intentional.
