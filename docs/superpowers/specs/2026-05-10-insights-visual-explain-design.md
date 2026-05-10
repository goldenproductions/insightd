# Insights — Visual + Explainable Drill-Down

**Status:** design
**Author:** Andreas
**Date:** 2026-05-10

## Problem

Today, the `/insights` page lists insights as cards. Clicking a card expands an inline panel showing four numeric tiles (current / baseline / deviation / entity) plus an optional co-occurring-logs list. Two gaps:

1. **Why is this happening?** — the user sees what changed but not the chain of reasoning. Diagnosis-engine evidence (ordered findings) is hidden inside `evidence` JSON; the rest of the categories synthesize nothing at all.
2. **Show me the data.** — there is no chart. The user must click through to the entity page and reconstruct the timeframe by hand.

We want insights to feel like a self-contained explanation: enough reasoning to trust the call, enough visual proof to verify it, enough timeline context to act on it — all inline on the Insights page.

## Goals

- Each expanded insight surfaces a structured reason chain ("Because X. Because Y. Because Z.") with confidence.
- Each expanded insight shows a chart appropriate to its category (forecast cone for predictions, week overlay for trends, sparkline + threshold for performance/health, uptime bars for availability).
- Each expanded insight shows a timeline of contributing events (log bursts, alert fires, restarts, threshold crossings) so the user can see what happened around the trigger time.
- One backend round-trip per expansion — no waterfalls, no chart data on the list response.
- Initial bundle size does not regress: charts dynamic-imported on expand.

## Non-goals (v1)

- Dedicated `/insights/:id` route — inline expand only.
- Cross-entity correlation overlays — chart shows the insight's own entity.
- Re-enabling the per-insight "Helpful?" feedback UI (tracked separately, see `InsightsPage.tsx` TODO).
- Caching the `/explain` response on the server.
- New schema columns or migrations — reads existing tables only.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Drill-down pattern | Inline expand, rebuilt | Compact, no nav cost, list stays visible |
| What to surface | Reasoning chain (A) + visual proof (B) | Build trust + verify call without leaving page |
| Chart approach | Per-category visuals | Each category has its own story; sparkline alone is reductive |
| Reasoning presentation | Structured summary + visual timeline | Quick scan up top, spatial proof underneath |
| Chart library | `recharts`, dynamic-imported | Trades small bundle hit for axes/tooltips/legends/cones for free |
| Scope | One PR | Full vision lands together |

## User-facing structure

When the user expands an insight card, four sections render in this order:

1. **Reason summary** — lead sentence + numbered reasons + confidence badge.
2. **Chart** — per-category visual.
3. **Contributing timeline** — markers for related events.
4. **Metadata** — entity link, metric, computed-at (existing).

The current "stats grid" tiles (current/baseline/deviation) collapse into the chart's threshold-line label and tooltip. Co-occurring logs become one marker class on the timeline.

## Backend

### New endpoint

```
GET /api/insights/:id/explain
```

Same auth and rate-limit as `/api/insights`. Returns:

```ts
type InsightExplanation = {
  summary: {
    lead: string;                              // "Memory saturation on db-prod"
    reasons: string[];                          // ordered, 1-5 items
    confidence: 'high' | 'medium' | 'low' | null;
  };
  chart: {
    kind: 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars';
    points: { ts: string; value: number }[];   // primary series
    compare?: { ts: string; value: number }[]; // week_overlay only
    forecast?: {
      ts: string; lower: number; upper: number; mid: number;
    }[];                                        // forecast only
    uptime?: {
      from: string; to: string; up: boolean;
    }[];                                        // uptime_bars only
    threshold?: number;                         // reference line value
    thresholdLabel?: string;                    // "P95 baseline" / "70% capacity"
    yLabel?: string;                            // "%", "MB", "load"
  };
  timeline: {
    ts: string;
    kind: 'log_burst' | 'alert_fired' | 'restart' | 'threshold_cross' | 'event';
    label: string;
    detail?: string;
    severity?: 'critical' | 'warning' | 'info';
    href?: string;
  }[];
};
```

### Implementation layout

New file: `hub/src/insights/explain.ts`

```ts
export async function buildExplanation(
  db: Database,
  insight: InsightRow,
): Promise<InsightExplanation>;
```

Composed of three pure helpers:

- `buildSummary(insight)` — uses persisted `evidence` if it parses to ordered lines (diagnosis-engine output); otherwise synthesizes from `category`/`metric`/`current_value`/`baseline_value`. `confidence` field passed through.
- `buildChart(db, insight)` — switches on `category`:
  - `performance` / `health` / `right_sizing` → `kind: 'sparkline'`, 24h window of `insight.metric` from the snapshot table for `insight.entity_type`. `threshold` = `baseline_value` or capacity threshold.
  - `trend` → `kind: 'week_overlay'`, 7d primary + 7d previous-week `compare`.
  - `prediction` → `kind: 'forecast'`, 14d history + projected `forecast` cone. Uses persisted forecast metadata if attached to the insight (current `disk_fill` insights compute this); otherwise re-derive minimally from baseline slope.
  - `availability` → `kind: 'uptime_bars'`, 24h window of up/down intervals from existing availability query.
- `buildTimeline(db, insight)` — merges and sorts:
  - `log_burst` markers from `evidence.log_bursts` (already structured).
  - `alert_fired` markers from `alerts` table where `entity_id` matches and timestamp is within window.
  - `restart` markers — `container_snapshots.restart_count` deltas (containers only).
  - `threshold_cross` markers — derived from chart points crossing `threshold`.
  - `event` markers — `events` table for the entity (k8s, host).

Caps: 25 markers max, drop oldest first.

### Window math

| Category | Window |
|---|---|
| performance, health, right_sizing | 24h |
| trend | 7d (× 2 with compare) |
| prediction | 14d |
| availability | 24h |

Window anchors:

- `performance` / `health` / `right_sizing` / `availability` → `[computed_at - window, computed_at]`.
- `trend` → `[computed_at - 7d, computed_at]` for `points`, `[computed_at - 14d, computed_at - 7d]` for `compare`.
- `prediction` → `[computed_at - 14d, computed_at]` for `points`, `[computed_at, computed_at + horizon]` for `forecast` (horizon comes from the persisted prediction metadata; `disk_fill` is 14d today).

### Route registration

`hub/src/web/server.ts`:

```ts
router.add('GET', '/api/insights/:id/explain', handlers.handleInsightExplain);
```

`hub/src/web/handlers.ts`:

```ts
export async function handleInsightExplain(req, res, params) {
  const id = parseInt(params.id, 10);
  const insight = getInsightById(db, id);
  if (!insight) return notFound(res);
  const explanation = await buildExplanation(db, insight);
  return json(res, explanation);
}
```

### Auth

The endpoint inherits the same authentication middleware as `/api/insights`. No new public-route entry.

### Performance

Each helper runs at most one snapshot query, one alerts query, one events query. All read prepared statements off existing indexes. Expected p95 < 50ms on a homelab DB.

## Frontend

### New components

```
hub/src/web/frontend/src/components/insights/
  ReasonSummary.tsx
  InsightChart.tsx                    (lazy entry, dispatches on chart.kind)
  ContributingTimeline.tsx
  charts/Sparkline.tsx
  charts/WeekOverlay.tsx
  charts/Forecast.tsx
  charts/UptimeBars.tsx
```

### Modified file

`hub/src/web/frontend/src/pages/InsightsPage.tsx` — `InsightCard` body rewritten. Collapsed view unchanged.

### Wiring

```tsx
const InsightChart = React.lazy(() => import('@/components/insights/InsightChart'));

function InsightCard({ insight, isExpanded, onToggle }) {
  const { data: explain } = useQuery({
    queryKey: ['insight-explain', insight.id],
    queryFn: () => api<InsightExplanation>(`/insights/${insight.id}/explain`),
    enabled: isExpanded,                // lazy: only fetch when opened
    staleTime: 60_000,
  });

  return (
    <div>
      {/* collapsed header (unchanged) */}
      {isExpanded && (
        explain ? (
          <>
            <ReasonSummary summary={explain.summary} />
            <Suspense fallback={<CardSkeleton lines={3} />}>
              <InsightChart chart={explain.chart} />
            </Suspense>
            <ContributingTimeline events={explain.timeline} />
            {/* metadata row (unchanged) */}
          </>
        ) : <CardSkeleton lines={4} />
      )}
    </div>
  );
}
```

### Bundle size

`recharts` lives behind `React.lazy` — it enters the bundle only when an insight is expanded. Verify the initial bundle delta is ≤ a few KB after the spec lands. If recharts ends up loaded on first paint anyway (e.g., through an accidental top-level import), treat that as a regression and fix before merge.

### Failure modes

- `/explain` 404 / 5xx → fall back to current static stats grid + co-occurring-logs render. Insight remains usable.
- `chart.points.length === 0` → render the reason summary and a "no metric history yet" placeholder where the chart would go. Still show timeline if non-empty.
- Recharts dynamic import fails → Suspense error boundary swaps in the static stats grid for that section.

## Testing

### Backend (`tests/insights/explain.test.ts`)

- `buildSummary` synthesizes one reason per category for capacity-based insights.
- `buildSummary` preserves diagnosis-engine evidence order when present.
- `buildChart` returns the correct `kind` for each category.
- `buildChart` returns a `forecast` payload for a `prediction` insight with persisted forecast metadata.
- `buildChart` window is 24h for `performance`, 14d for `prediction`, 7d×2 for `trend`.
- `buildTimeline` merges log bursts + alert fires + restart deltas in chronological order, capped at 25.
- `buildTimeline` injects `threshold_cross` markers where points cross the threshold.
- Legacy / empty `evidence` rows do not throw.
- `handleInsightExplain` returns 404 for unknown id; 200 for valid id.

### Frontend

No unit tests (matches repo norm). Manual UI test on the dev VM:

- Expand one insight per category in turn (performance, trend, prediction, availability, health, right_sizing). Verify the right chart kind renders.
- Network tab: `/insights/:id/explain` is fetched only on first expand and reused on re-expand within `staleTime`.
- Build size: `npm run build` and confirm initial bundle has not gained more than a few KB. Recharts shows up in a separate lazy chunk.

### Type + lint gates

`npm test`, `npm run typecheck`, `npm run build` all green before push.

## Rollout

1. Branch `insights-visual-explain`.
2. Backend: `explain.ts` + handler + route + tests.
3. Frontend: components + `InsightsPage.tsx` integration + `recharts` dep.
4. CI green.
5. Deploy to dev VM, verify ≥ 1 insight per category renders correctly.
6. Open PR with screenshots of each chart kind.
7. After merge, update `memory/project_insightd.md` index line for the new endpoint and UI shift.

## Out of scope / follow-ups

- Caching `/explain` responses (add when DB load shows it).
- Dedicated `/insights/:id` route for shareable URLs.
- Re-enabling per-insight feedback UI (tracked in existing `InsightsPage.tsx` TODO).
- Cross-entity correlation overlays.
- Per-insight "open in entity" deep-link with the chart's time window pre-selected.
