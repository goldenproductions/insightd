import type { BaselineRow } from '@/types/api';

export interface MetricRating {
  rating: 'normal' | 'elevated' | 'high' | 'critical';
  percentilePosition: number;
  label: string;
}

/**
 * Rate a metric value against its baseline, but only if the absolute value
 * is high enough to matter. Low utilization is always "normal" regardless
 * of where it sits relative to the baseline — usage isn't a problem,
 * saturation is.
 */
export function rateMetric(value: number | null | undefined, baseline: BaselineRow | undefined, metric?: string): MetricRating | null {
  if (value == null || !baseline || baseline.sample_count < 288) return null;
  if (baseline.p75 == null || baseline.p95 == null || baseline.p99 == null) return null;

  // Capacity floor: if the absolute value is low, it's always normal.
  // CPU <50%, memory <500 MB, load <4 — these are not concerning regardless of percentile.
  if (metric) {
    if ((metric === 'cpu_percent' || metric === 'gpu_utilization_percent') && value < 50) return null;
    if ((metric === 'memory_mb' || metric === 'memory_used_mb') && value < 500) return null;
    if ((metric === 'load_1' || metric === 'load_5') && value < 4) return null;
  }

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
