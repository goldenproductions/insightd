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
