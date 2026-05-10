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

type ChartKind = 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars' | 'restart_histogram';

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

function chartWindowHours(category: string): number {
  switch (category) {
    case 'trend':      return 24 * 7;
    case 'prediction': return 24 * 14;
    default:           return 24;
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

// Hard-coded allowlist — never interpolate raw metric strings into SQL.
const HOST_METRIC_COLUMN: Record<string, string> = {
  cpu_percent:    'cpu_percent',
  memory_used_mb: 'memory_used_mb',
  load_5:         'load_5',
};

function normalizeMetric(metric: string, prefix: string): string {
  // Strip optional entity-type prefix (e.g. "host.cpu_percent" → "cpu_percent").
  if (metric.startsWith(prefix + '.')) return metric.slice(prefix.length + 1);
  return metric;
}

function fetchHostMetricSeries(
  db: Database.Database, hostId: string, metric: string, fromIso: string, toIso: string,
): ChartPoint[] {
  const bare = normalizeMetric(metric, 'host');

  // Computed percentage derived from memory_used_mb / memory_total_mb.
  if (bare === 'memory_percent') {
    return db.prepare(`
      SELECT collected_at AS ts,
             CASE WHEN memory_total_mb > 0 THEN (memory_used_mb * 100.0 / memory_total_mb) ELSE NULL END AS value
      FROM host_snapshots
      WHERE host_id = ? AND collected_at BETWEEN ? AND ?
      ORDER BY collected_at ASC
    `).all(hostId, fromIso, toIso) as ChartPoint[];
  }

  const column = HOST_METRIC_COLUMN[bare] ?? null;
  if (!column) return [];
  return db.prepare(`
    SELECT collected_at AS ts, ${column} AS value
    FROM host_snapshots
    WHERE host_id = ? AND collected_at BETWEEN ? AND ? AND ${column} IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, fromIso, toIso) as ChartPoint[];
}

const CONTAINER_METRIC_COLUMN: Record<string, string> = {
  cpu_percent: 'cpu_percent',
  memory_mb:   'memory_mb',
};

function fetchContainerMetricSeries(
  db: Database.Database, entityId: string, metric: string, fromIso: string, toIso: string,
): ChartPoint[] {
  const [hostId, ...nameParts] = entityId.split('/');
  const containerName = nameParts.join('/');
  const bare = normalizeMetric(metric, 'container');
  const column = CONTAINER_METRIC_COLUMN[bare] ?? null;
  if (!column) return [];
  return db.prepare(`
    SELECT collected_at AS ts, ${column} AS value
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ? AND collected_at BETWEEN ? AND ? AND ${column} IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, containerName, fromIso, toIso) as ChartPoint[];
}

function fetchDiskSeries(
  db: Database.Database, hostId: string, mountPoint: string, fromIso: string, toIso: string,
): ChartPoint[] {
  return db.prepare(`
    SELECT collected_at AS ts, used_percent AS value
    FROM disk_snapshots
    WHERE host_id = ? AND mount_point = ? AND collected_at BETWEEN ? AND ? AND used_percent IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, mountPoint, fromIso, toIso) as ChartPoint[];
}

function fetchSeries(
  db: Database.Database, insight: InsightRow, fromIso: string, toIso: string,
): ChartPoint[] {
  if (insight.entity_type === 'host') {
    const metric = insight.metric ?? '';
    const bare = normalizeMetric(metric, 'host');
    if (bare === 'disk_used_percent') {
      // Disk insights are stored with entity_type='host'; mount_point lives in evidence.
      let mountPoint: string | null = null;
      try {
        const parsed = insight.evidence ? JSON.parse(insight.evidence) : null;
        if (parsed && typeof parsed.mount_point === 'string') {
          mountPoint = parsed.mount_point;
        }
      } catch { /* fall through */ }
      if (!mountPoint) return [];
      return fetchDiskSeries(db, insight.entity_id, mountPoint, fromIso, toIso);
    }
    return fetchHostMetricSeries(db, insight.entity_id, metric, fromIso, toIso);
  }
  if (insight.entity_type === 'container') {
    return fetchContainerMetricSeries(db, insight.entity_id, insight.metric ?? '', fromIso, toIso);
  }
  return [];
}

function tsAt(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function offsetIso(baseIso: string, hoursDelta: number): string {
  const t = new Date(baseIso.replace(' ', 'T') + 'Z');
  return tsAt(new Date(t.getTime() + hoursDelta * 60 * 60 * 1000));
}

function buildUptimeIntervals(
  db: Database.Database, entityId: string, fromIso: string, toIso: string,
): { from: string; to: string; up: boolean }[] {
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

function bucketRestartsByHour(deltas: { ts: string; delta: number }[], fromIso: string, toIso: string): ChartPoint[] {
  const fromMs = new Date(fromIso.replace(' ', 'T') + 'Z').getTime();
  const toMs   = new Date(toIso.replace(' ', 'T') + 'Z').getTime();
  const hours = Math.max(1, Math.ceil((toMs - fromMs) / 3_600_000));
  const buckets = new Array(hours).fill(0);
  for (const d of deltas) {
    const tMs = new Date(d.ts.replace(' ', 'T') + 'Z').getTime();
    const idx = Math.min(hours - 1, Math.max(0, Math.floor((tMs - fromMs) / 3_600_000)));
    buckets[idx] += d.delta;
  }
  return buckets.map((value, i) => ({
    ts: tsAt(new Date(fromMs + i * 3_600_000)),
    value,
  }));
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
  if (kind === 'week_overlay') {
    const thisFrom = offsetIso(insight.computed_at, -24 * 7);
    const lastFrom = offsetIso(insight.computed_at, -24 * 14);
    const lastTo   = offsetIso(insight.computed_at, -24 * 7);
    const points  = fetchSeries(db, insight, thisFrom, insight.computed_at);
    const compare = fetchSeries(db, insight, lastFrom, lastTo);
    return { kind, points, compare, threshold, thresholdLabel, yLabel };
  }
  if (kind === 'uptime_bars') {
    const fromIso = offsetIso(insight.computed_at, -24);
    if (insight.entity_type === 'container') {
      const [hostId, ...nameParts] = insight.entity_id.split('/');
      const containerName = nameParts.join('/');
      const deltas = fetchContainerRestartDeltas(db, hostId, containerName, fromIso, insight.computed_at);
      if (deltas.length > 0) {
        const points = bucketRestartsByHour(deltas, fromIso, insight.computed_at);
        return { kind: 'restart_histogram', points };
      }
    }
    const uptime = buildUptimeIntervals(db, insight.entity_id, fromIso, insight.computed_at);
    return { kind, points: [], uptime, thresholdLabel: 'Target' };
  }
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
  return { kind, points: [], threshold, thresholdLabel, yLabel };
}

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
  const fromIso = offsetIso(insight.computed_at, -chartWindowHours(insight.category));
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
  return markers.length > 25 ? markers.slice(markers.length - 25) : markers;
}

function buildExplanation(db: Database.Database, insight: InsightRow) {
  const summary  = buildSummary(insight);
  const chart    = buildChart(db, insight);
  const timeline = buildTimeline(db, insight, chart.points);
  return { summary, chart, timeline };
}

module.exports = { buildSummary, buildChart, buildTimeline, buildExplanation };
