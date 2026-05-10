import type Database from 'better-sqlite3';

/**
 * Disk-fill ETA predictions. One insight per (host, mount) or (host, storage)
 * that will reach saturation within 14 days at the current 7-day growth
 * rate. Sibling to right-sizing and proxmox-checks — runs from the
 * generateInsights cycle and writes into the shared `insights` table under
 * category 'prediction'.
 */

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

interface DiskInsightInsert {
  run(
    entityType: string,
    entityId: string,
    category: string,
    severity: 'critical' | 'warning' | 'info',
    title: string,
    message: string,
    metric: string | null,
    currentValue: number | null,
    baselineValue: number | null,
    evidence: string | null,
    suggestedAction: string | null,
    confidence: string | null,
  ): { changes: number };
}

interface DiskRow { host_id: string; mount_point: string; total_gb: number; used_gb: number; used_percent: number }
interface DailyDiskRow { day: string; avg: number | null }

function generateDiskInsights(db: Database.Database, insert: DiskInsightInsert): number {
  // Hoist all prepared statements outside the loop — compile once, run many.
  const latestStmt = db.prepare(`
    SELECT host_id, mount_point, total_gb, used_gb, used_percent
    FROM disk_snapshots ds
    WHERE collected_at = (
      SELECT MAX(collected_at) FROM disk_snapshots
      WHERE host_id = ds.host_id AND mount_point = ds.mount_point
    )
  `);
  const dailyStmt = db.prepare(`
    SELECT DATE(collected_at) AS day, AVG(used_gb) AS avg
    FROM disk_snapshots
    WHERE host_id = ? AND mount_point = ?
      AND collected_at >= datetime('now', '-7 days')
    GROUP BY DATE(collected_at)
    ORDER BY day
  `);
  const alertStmt = db.prepare(`
    SELECT 1 FROM alert_state
    WHERE alert_type = ? AND host_id = ? AND target = ? AND resolved_at IS NULL
    LIMIT 1
  `);

  let count = 0;
  const latest = latestStmt.all() as DiskRow[];

  for (const row of latest) {
    if (!row.total_gb || row.total_gb <= 0) continue;
    if (row.used_percent < FLOOR_USED_PERCENT) continue;
    if (row.used_gb >= row.total_gb) continue;
    if (alertStmt.get('disk_full', row.host_id, row.mount_point)) continue;

    const daily = dailyStmt.all(row.host_id, row.mount_point) as DailyDiskRow[];
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

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

interface PveStorageRow { host_id: string; storage_name: string; storage_type: string; total_bytes: number; used_bytes: number; active: number }
interface DailyPveRow { day: string; avg: number | null }

function generatePveStorageInsights(db: Database.Database, insert: DiskInsightInsert): number {
  const latestStmt = db.prepare(`
    SELECT host_id, storage_name, storage_type, total_bytes, used_bytes, active
    FROM pve_storage_snapshots ps
    WHERE collected_at = (
      SELECT MAX(collected_at) FROM pve_storage_snapshots
      WHERE host_id = ps.host_id AND storage_name = ps.storage_name
    )
  `);
  const dailyStmt = db.prepare(`
    SELECT DATE(collected_at) AS day, AVG(used_bytes) AS avg
    FROM pve_storage_snapshots
    WHERE host_id = ? AND storage_name = ?
      AND collected_at >= datetime('now', '-7 days')
    GROUP BY DATE(collected_at)
    ORDER BY day
  `);
  const alertStmt = db.prepare(`
    SELECT 1 FROM alert_state
    WHERE alert_type = ? AND host_id = ? AND target = ? AND resolved_at IS NULL
    LIMIT 1
  `);

  let count = 0;
  const latest = latestStmt.all() as PveStorageRow[];

  for (const row of latest) {
    if (!row.total_bytes || row.total_bytes <= 0) continue;
    if (!row.active) continue;
    const usedPct = (row.used_bytes / row.total_bytes) * 100;
    if (usedPct < FLOOR_USED_PERCENT) continue;
    if (row.used_bytes >= row.total_bytes) continue;
    if (alertStmt.get('pve_storage_saturation', row.host_id, row.storage_name)) continue;

    const daily = dailyStmt.all(row.host_id, row.storage_name) as DailyPveRow[];
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

export function generateDiskFillInsights(db: Database.Database): number {
  const insert = db.prepare(`
    INSERT INTO insights
      (entity_type, entity_id, category, severity, title, message,
       metric, current_value, baseline_value, evidence,
       suggested_action, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `) as unknown as DiskInsightInsert;
  let count = 0;
  count += generateDiskInsights(db, insert);
  count += generatePveStorageInsights(db, insert);
  return count;
}

module.exports = { generateDiskFillInsights, dailyTrend };
