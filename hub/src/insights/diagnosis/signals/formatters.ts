/**
 * Shared formatters used by every signal detector so their evidence strings
 * stay consistent. Values are bucketed so small fluctuations don't rewrite
 * the evidence on every re-run (the sticky layer freezes evidence while the
 * conclusion is unchanged, but signal detectors still want stable output).
 */

export function round(v: number | null): string {
  if (v == null) return '?';
  return Math.round(v * 10) / 10 + '';
}

export function bucket(v: number | null, step: number, unit: string): string {
  if (v == null) return '?';
  return `~${Math.round(v / step) * step}${unit}`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

module.exports = { round, bucket, formatDuration };
