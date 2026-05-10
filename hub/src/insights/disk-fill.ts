import type Database from 'better-sqlite3';

/**
 * Disk-fill ETA predictions. One insight per (host, mount) or (host, storage)
 * that will reach saturation within 14 days at the current 7-day growth
 * rate. Sibling to right-sizing and proxmox-checks — runs from the
 * generateInsights cycle and writes into the shared `insights` table under
 * category 'prediction'.
 */

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

export function generateDiskFillInsights(db: Database.Database): number {
  void db;
  return 0;
}

module.exports = { generateDiskFillInsights, dailyTrend };
