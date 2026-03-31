export interface Baseline {
  metric: string;
  time_bucket: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  sample_count: number;
}

export interface MetricRating {
  rating: 'normal' | 'elevated' | 'high' | 'critical';
  percentilePosition: number;
  label: string;
}

export function rateMetric(value: number | null | undefined, baseline: Baseline | undefined): MetricRating | null {
  if (value == null || !baseline || baseline.sample_count < 288) return null;
  if (baseline.p75 == null || baseline.p95 == null || baseline.p99 == null) return null;

  let pct: number;
  if (value <= (baseline.p50 ?? 0)) pct = baseline.p50 ? Math.round(50 * (value / baseline.p50)) : 0;
  else if (value <= baseline.p75) pct = 50 + Math.round(25 * ((value - (baseline.p50 ?? 0)) / (baseline.p75 - (baseline.p50 ?? 0) || 1)));
  else if (value <= (baseline.p90 ?? baseline.p95)) pct = 75 + Math.round(15 * ((value - baseline.p75) / ((baseline.p90 ?? baseline.p95) - baseline.p75 || 1)));
  else if (value <= baseline.p95) pct = 90 + Math.round(5 * ((value - (baseline.p90 ?? baseline.p75)) / (baseline.p95 - (baseline.p90 ?? baseline.p75) || 1)));
  else if (value <= baseline.p99) pct = 95 + Math.round(4 * ((value - baseline.p95) / (baseline.p99 - baseline.p95 || 1)));
  else pct = 100;

  pct = Math.max(0, Math.min(100, pct));

  const rating = pct <= 75 ? 'normal' : pct <= 90 ? 'elevated' : pct <= 95 ? 'high' : 'critical';
  return { rating, percentilePosition: pct, label: `P${pct}` };
}

export const ratingColors: Record<string, string> = {
  normal: 'var(--color-success)',
  elevated: 'var(--color-warning)',
  high: '#f97316',
  critical: 'var(--color-danger)',
};
