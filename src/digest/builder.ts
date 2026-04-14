import type Database from 'better-sqlite3';
import logger = require('../utils/logger');

interface DigestConfig {
  diskWarnPercent: number;
}

interface ContainerStat {
  host_id: string;
  container_name: string;
  total_snapshots: number;
  running_snapshots: number;
  max_restarts: number;
  min_restarts: number;
}

interface ResourceTrend {
  host_id: string;
  container_name: string;
  this_week_cpu: number | null;
  last_week_cpu: number | null;
  this_week_ram: number | null;
  last_week_ram: number | null;
}

interface DiskRow {
  host_id: string;
  mount_point: string;
  total_gb: number;
  used_gb: number;
  used_percent: number;
}

interface UpdateRow {
  host_id: string;
  container_name: string;
  image: string;
  has_update: number;
}

interface EndpointDigest {
  name: string;
  uptimePercent: number | null;
  avgResponseMs: number | null;
}

interface DigestAlert {
  type: string;
  target: string;
  hostId: string;
  message: string;
  triggeredAt: string;
  resolvedAt: string | null;
  durationMinutes: number;
  reminderCount: number;
}

interface DigestAnomaly {
  entityType: string;
  entityId: string;
  metric: string;
  bucketStart: string;
  robustZ: number;
}

interface DigestHostGroup {
  group: string | null;
  hostIds: string[];
}

interface DigestContainer {
  name: string;
  hostId: string;
  uptimePercent: number;
  restarts: number;
  status: string;
}

interface DigestTrend {
  name: string;
  cpuAvg: number | null;
  ramAvgMb: number | null;
  cpuChange: number | null;
  ramChange: number | null;
  flagged: boolean;
}

interface DigestData {
  weekNumber: number;
  generatedAt: string;
  overallStatus: string;
  summaryLine: string;
  overallUptime: number;
  totalRestarts: number;
  restartedContainers: string[];
  containers: DigestContainer[];
  trends: DigestTrend[];
  disk: DiskRow[];
  diskWarnings: DiskRow[];
  updatesAvailable: UpdateRow[];
  hostCount: number;
  endpoints: EndpointDigest[];
  triggeredAlertsThisWeek: DigestAlert[];
  anomaliesThisWeek: DigestAnomaly[];
  hostGroups: DigestHostGroup[];
}

function buildDigest(db: Database.Database, config: DigestConfig): DigestData {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const thisWeekStart = weekAgo.toISOString().slice(0, 19).replace('T', ' ');
  const lastWeekStart = twoWeeksAgo.toISOString().slice(0, 19).replace('T', ' ');
  const nowStr = now.toISOString().slice(0, 19).replace('T', ' ');

  // Detect how many hosts we have
  const hostRows = db.prepare('SELECT DISTINCT host_id FROM container_snapshots WHERE collected_at BETWEEN ? AND ?').all(thisWeekStart, nowStr) as { host_id: string }[];
  const multiHost = hostRows.length > 1;

  // --- Container uptime & restarts ---
  const containerStats = db.prepare(`
    SELECT
      host_id,
      container_name,
      COUNT(*) as total_snapshots,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running_snapshots,
      MAX(restart_count) as max_restarts,
      MIN(restart_count) as min_restarts
    FROM container_snapshots
    WHERE collected_at BETWEEN ? AND ?
    GROUP BY host_id, container_name
    ORDER BY host_id, container_name
  `).all(thisWeekStart, nowStr) as ContainerStat[];

  const containers: DigestContainer[] = containerStats.map(c => {
    const uptimePercent = c.total_snapshots > 0
      ? Math.round((c.running_snapshots / c.total_snapshots) * 100 * 10) / 10
      : 0;
    const restarts = Math.max(0, c.max_restarts - c.min_restarts);
    const displayName = multiHost ? `${c.host_id}/${c.container_name}` : c.container_name;
    return {
      name: displayName,
      hostId: c.host_id,
      uptimePercent,
      restarts,
      status: uptimePercent >= 99 ? 'green' : uptimePercent >= 90 ? 'yellow' : 'red',
    };
  });

  const overallUptime = containers.length > 0
    ? Math.round(containers.reduce((sum, c) => sum + c.uptimePercent, 0) / containers.length * 10) / 10
    : 100;

  const totalRestarts = containers.reduce((sum, c) => sum + c.restarts, 0);
  const restartedContainers = containers.filter(c => c.restarts > 0).map(c => c.name);

  // --- Resource trends (this week vs last week) ---
  const resourceTrends = db.prepare(`
    SELECT
      host_id,
      container_name,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as this_week_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as last_week_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_mb END) as this_week_ram,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_mb END) as last_week_ram
    FROM container_snapshots
    WHERE collected_at BETWEEN ? AND ?
    GROUP BY host_id, container_name
  `).all(
    thisWeekStart, nowStr,
    lastWeekStart, thisWeekStart,
    thisWeekStart, nowStr,
    lastWeekStart, thisWeekStart,
    lastWeekStart, nowStr
  ) as ResourceTrend[];

  const trends: DigestTrend[] = resourceTrends
    .map(r => {
      const cpuChange = r.last_week_cpu && r.this_week_cpu
        ? Math.round(((r.this_week_cpu - r.last_week_cpu) / r.last_week_cpu) * 100)
        : null;
      const ramChange = r.last_week_ram && r.this_week_ram
        ? Math.round(((r.this_week_ram - r.last_week_ram) / r.last_week_ram) * 100)
        : null;
      const displayName = multiHost ? `${r.host_id}/${r.container_name}` : r.container_name;
      return {
        name: displayName,
        cpuAvg: r.this_week_cpu ? Math.round(r.this_week_cpu * 10) / 10 : null,
        ramAvgMb: r.this_week_ram ? Math.round(r.this_week_ram) : null,
        cpuChange,
        ramChange,
        flagged: (cpuChange !== null && Math.abs(cpuChange) > 10) || (ramChange !== null && Math.abs(ramChange) > 10),
      };
    })
    .filter(t => t.flagged);

  // --- Disk usage ---
  const latestDisk = db.prepare(`
    SELECT host_id, mount_point, total_gb, used_gb, used_percent
    FROM disk_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM disk_snapshots)
  `).all() as DiskRow[];

  const diskWarnings = latestDisk.filter(d => d.used_percent >= config.diskWarnPercent);

  // --- Update checks ---
  const latestUpdates = db.prepare(`
    SELECT host_id, container_name, image, has_update
    FROM update_checks
    WHERE checked_at = (SELECT MAX(checked_at) FROM update_checks)
      AND has_update = 1
  `).all() as UpdateRow[];

  // --- HTTP endpoint stats ---
  let endpoints: EndpointDigest[] = [];
  try {
    const { getEndpointsForDigest } = require('../../hub/src/http-monitor/queries') as any;
    endpoints = getEndpointsForDigest(db);
  } catch {
    // http-monitor module not available
  }

  // --- Alerts fired during the week ---
  let triggeredAlertsThisWeek: DigestAlert[] = [];
  try {
    const alertRows = db.prepare(`
      SELECT host_id, alert_type, target, message, triggered_at, resolved_at, notify_count,
             CAST((julianday(COALESCE(resolved_at, 'now')) - julianday(triggered_at)) * 1440 AS INTEGER) AS duration_minutes
      FROM alert_state
      WHERE triggered_at >= ?
      ORDER BY duration_minutes DESC
      LIMIT 20
    `).all(thisWeekStart) as Array<{
      host_id: string;
      alert_type: string;
      target: string;
      message: string;
      triggered_at: string;
      resolved_at: string | null;
      notify_count: number;
      duration_minutes: number;
    }>;
    triggeredAlertsThisWeek = alertRows.map(r => ({
      type: r.alert_type,
      target: r.target,
      hostId: r.host_id,
      message: r.message,
      triggeredAt: r.triggered_at,
      resolvedAt: r.resolved_at,
      durationMinutes: r.duration_minutes || 0,
      reminderCount: Math.max(0, (r.notify_count || 1) - 1),
    }));
  } catch {
    // alert_state table not present
  }

  // --- Anomalies detected during the week ---
  let anomaliesThisWeek: DigestAnomaly[] = [];
  try {
    anomaliesThisWeek = (db.prepare(`
      SELECT entity_type, entity_id, metric, bucket_start, robust_z
      FROM rollup_anomalies
      WHERE bucket_start >= ?
      ORDER BY ABS(robust_z) DESC
      LIMIT 10
    `).all(thisWeekStart) as Array<{ entity_type: string; entity_id: string; metric: string; bucket_start: string; robust_z: number }>).map(r => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      metric: r.metric,
      bucketStart: r.bucket_start,
      robustZ: r.robust_z,
    }));
  } catch {
    // rollup_anomalies table not present
  }

  // --- Host groups (single-host standalone mode typically has none) ---
  let hostGroups: DigestHostGroup[] = [];
  try {
    const hostRowsWithGroup = db.prepare(`
      SELECT host_id, COALESCE(host_group_override, host_group) AS host_group
      FROM hosts
      ORDER BY host_group, host_id
    `).all() as Array<{ host_id: string; host_group: string | null }>;
    const grouped = new Map<string | null, string[]>();
    for (const row of hostRowsWithGroup) {
      const key = row.host_group || null;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row.host_id);
    }
    hostGroups = Array.from(grouped.entries()).map(([group, hostIds]) => ({ group, hostIds }));
  } catch {
    // hosts table not present (standalone mode may not track hosts)
  }

  // --- Build summary ---
  const issues: string[] = [];
  if (containers.some(c => c.status === 'red')) issues.push('container downtime');
  if (totalRestarts > 0) issues.push(`${totalRestarts} restart${totalRestarts > 1 ? 's' : ''}`);
  if (diskWarnings.length > 0) issues.push('disk space warning');
  if (trends.length > 0) issues.push('resource changes');
  const endpointsWithDowntime = endpoints.filter(e => e.uptimePercent != null && (e.uptimePercent as number) < 99);
  if (endpointsWithDowntime.length > 0) issues.push(`${endpointsWithDowntime.length} endpoint${endpointsWithDowntime.length > 1 ? 's' : ''} had downtime`);

  const weekNumber = getWeekNumber(now);
  const summaryLine = issues.length === 0
    ? 'No critical issues. Good week.'
    : `${issues.length} thing${issues.length > 1 ? 's' : ''} need${issues.length === 1 ? 's' : ''} attention.`;

  const overallStatus = issues.length === 0 ? 'green' : issues.length <= 2 ? 'yellow' : 'red';

  const digest: DigestData = {
    weekNumber,
    generatedAt: now.toISOString(),
    overallStatus,
    summaryLine,
    overallUptime,
    totalRestarts,
    restartedContainers,
    containers,
    trends,
    disk: latestDisk,
    diskWarnings,
    updatesAvailable: latestUpdates,
    hostCount: hostRows.length,
    endpoints,
    triggeredAlertsThisWeek,
    anomaliesThisWeek,
    hostGroups,
  };

  logger.info('digest', `Built digest for week ${weekNumber} (${hostRows.length} host${hostRows.length !== 1 ? 's' : ''}): ${summaryLine}`);
  return digest;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

module.exports = { buildDigest };
