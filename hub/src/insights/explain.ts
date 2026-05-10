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
  if (metric === 'host.memory_percent') {
    return db.prepare(`
      SELECT collected_at AS ts,
             CASE WHEN memory_total_mb > 0 THEN (memory_used_mb * 100.0 / memory_total_mb) ELSE NULL END AS value
      FROM host_snapshots
      WHERE host_id = ? AND collected_at BETWEEN ? AND ?
      ORDER BY collected_at ASC
    `).all(hostId, fromIso, toIso) as ChartPoint[];
  }
  const column = (() => {
    if (metric === 'host.cpu_percent') return 'cpu_percent';
    if (metric === 'host.load_5')      return 'load_5';
    return null;
  })();
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

function fetchDiskSeries(
  db: Database.Database, entityId: string, fromIso: string, toIso: string,
): ChartPoint[] {
  const [hostId, ...mountParts] = entityId.split('/');
  const mountpoint = '/' + mountParts.join('/');
  return db.prepare(`
    SELECT collected_at AS ts, used_percent AS value
    FROM disk_snapshots
    WHERE host_id = ? AND mount_point = ? AND collected_at BETWEEN ? AND ? AND used_percent IS NOT NULL
    ORDER BY collected_at ASC
  `).all(hostId, mountpoint, fromIso, toIso) as ChartPoint[];
}

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

module.exports = { buildSummary, buildChart };
