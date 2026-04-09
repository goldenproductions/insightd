import type Database from 'better-sqlite3';

const { SCHEMA_VERSION } = require('../db/schema') as { SCHEMA_VERSION: number };
const { VERSION } = require('../config') as { VERSION: string };

const startTime = Date.now();

// --- Row interfaces ---

interface HostRow {
  host_id: string;
  first_seen: string;
  last_seen: string;
  agent_version: string | null;
  runtime_type: string;
  is_online: number;
}

interface HostDetailRow {
  host_id: string;
  first_seen: string;
  last_seen: string;
  runtime_type: string;
  is_online: number;
}

interface ContainerRow {
  container_name: string;
  container_id: string;
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  network_rx_bytes: number | null;
  network_tx_bytes: number | null;
  blkio_read_bytes: number | null;
  blkio_write_bytes: number | null;
  health_status: string | null;
  labels: string | null;
  collected_at: string;
}

interface DiskRow {
  mount_point: string;
  total_gb: number;
  used_gb: number;
  used_percent: number;
  collected_at: string;
}

interface UpdateRow {
  container_name: string;
  image: string;
  has_update: number;
  checked_at: string;
}

interface AlertRow {
  id: number;
  host_id: string;
  alert_type: string;
  target: string;
  triggered_at: string;
  resolved_at: string | null;
  last_notified: string;
  notify_count: number;
  message: string | null;
  trigger_value: string | null;
  threshold: string | null;
}

interface CountRow {
  count: number;
}

interface ContainerStatusRow {
  status: string;
  labels: string | null;
}

interface HealthScoreRow {
  entity_id: string;
  score: number;
  factors: string;
  computed_at: string;
}

interface InsightRow {
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
}

interface HostMetricsRow {
  cpu_percent: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_available_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  uptime_seconds: number | null;
  gpu_utilization_percent: number | null;
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
  gpu_temperature_celsius: number | null;
  cpu_temperature_celsius: number | null;
  disk_read_bytes_per_sec: number | null;
  disk_write_bytes_per_sec: number | null;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  collected_at: string;
}

interface HostMetricsHistoryRow {
  cpu_percent: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_available_mb: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  gpu_utilization_percent: number | null;
  gpu_temperature_celsius: number | null;
  cpu_temperature_celsius: number | null;
  disk_read_bytes_per_sec: number | null;
  disk_write_bytes_per_sec: number | null;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  collected_at: string;
}

interface ContainerHistoryRow {
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  network_rx_bytes: number | null;
  network_tx_bytes: number | null;
  blkio_read_bytes: number | null;
  blkio_write_bytes: number | null;
  health_status: string | null;
  collected_at: string;
}

interface ContainerAlertRow {
  id: number;
  alert_type: string;
  target: string;
  triggered_at: string;
  resolved_at: string | null;
  last_notified: string;
  message: string | null;
  trigger_value: string | null;
  threshold: string | null;
  notify_count: number;
}

interface ContainerIdRow {
  container_id: string;
}

interface UptimeSnapshotRow {
  container_name: string;
  status: string;
  collected_at: string;
}

interface ResourceRow {
  host_id: string;
  container_name: string;
  cpu_percent: number | null;
  memory_mb: number | null;
}

interface ContainerTrendRow {
  container_name: string;
  this_cpu: number | null;
  last_cpu: number | null;
  this_mem: number | null;
  last_mem: number | null;
}

interface HostTrendRow {
  this_cpu: number | null;
  last_cpu: number | null;
  this_mem: number | null;
  last_mem: number | null;
  this_load: number | null;
  last_load: number | null;
}

interface StatusChangeRow {
  container_name: string;
  new_status: string;
  old_status: string;
  time: string;
}

interface AlertEventRow {
  alert_type: string;
  target: string;
  triggered_at: string;
  resolved_at: string | null;
}

interface MountPointRow {
  mount_point: string;
}

interface DiskForecastDataRow {
  used_gb: number;
  total_gb: number;
  used_percent: number;
  collected_at: string;
}

interface ImageUpdateRow {
  host_id: string;
  container_name: string;
  image: string;
  checked_at: string;
}

interface DowntimeChangeRow {
  new_status: string;
  old_status: string;
  time: string;
}

interface DowntimeSnapshotRow {
  status: string;
  collected_at: string;
}

interface AvailabilityRow {
  host_id: string;
  container_name: string;
  labels: string | null;
  total: number;
  running: number;
}

function getHealth(db: Database.Database): { status: string; uptime: number; version: string; schemaVersion: number } {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}

function getHosts(db: Database.Database, onlineThresholdMinutes: number): HostRow[] {
  return db.prepare(`
    SELECT host_id, first_seen, last_seen, agent_version, runtime_type,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts ORDER BY host_id
  `).all(onlineThresholdMinutes) as HostRow[];
}

function getHostDetail(db: Database.Database, hostId: string, onlineThresholdMinutes: number, showInternal: boolean = false): any {
  const host = db.prepare(`
    SELECT host_id, first_seen, last_seen, runtime_type,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts WHERE host_id = ?
  `).get(onlineThresholdMinutes, hostId) as HostDetailRow | undefined;

  if (!host) return null;

  return {
    ...host,
    containers: getLatestContainers(db, hostId, showInternal),
    disk: getLatestDisk(db, hostId),
    alerts: getAlerts(db, true, hostId),
    updates: getLatestUpdates(db, hostId),
    hostMetrics: getLatestHostMetrics(db, hostId),
    diskForecast: getDiskForecast(db, hostId),
  };
}

function getLatestContainers(db: Database.Database, hostId: string, showInternal: boolean = false): ContainerRow[] {
  // Only return containers seen in the last 15 minutes — drops "ghost" entries
  // for containers that were once reported but have since been deleted or
  // filtered out (e.g. completed K8s Job pods, removed Docker containers).
  // Historical snapshots stay in the DB for the timeline view; this only
  // affects the current host detail view.
  const rows = db.prepare(`
    SELECT cs.container_name, cs.container_id, cs.status,
           cs.cpu_percent, cs.memory_mb, cs.restart_count,
           cs.network_rx_bytes, cs.network_tx_bytes, cs.blkio_read_bytes, cs.blkio_write_bytes,
           cs.health_status, cs.labels, cs.collected_at
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id, container_name, MAX(collected_at) as max_at
      FROM container_snapshots WHERE host_id = ?
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.host_id
      AND cs.container_name = latest.container_name
      AND cs.collected_at = latest.max_at
    WHERE cs.collected_at > datetime('now', '-15 minutes')
    ORDER BY cs.container_name
  `).all(hostId) as ContainerRow[];
  if (showInternal) return rows;
  return rows.filter(r => {
    if (!r.labels) return true;
    try { return JSON.parse(r.labels)['insightd.internal'] !== 'true'; } catch { return true; }
  });
}

function getLatestDisk(db: Database.Database, hostId: string): DiskRow[] {
  return db.prepare(`
    SELECT mount_point, total_gb, used_gb, used_percent, collected_at
    FROM disk_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM disk_snapshots WHERE host_id = ?
    )
    ORDER BY mount_point
  `).all(hostId, hostId) as DiskRow[];
}

function getLatestUpdates(db: Database.Database, hostId: string): UpdateRow[] {
  return db.prepare(`
    SELECT container_name, image, has_update, checked_at
    FROM update_checks
    WHERE host_id = ? AND checked_at = (
      SELECT MAX(checked_at) FROM update_checks WHERE host_id = ?
    ) AND has_update = 1
    ORDER BY container_name
  `).all(hostId, hostId) as UpdateRow[];
}

function getAlerts(db: Database.Database, activeOnly?: boolean, hostId?: string): AlertRow[] {
  let sql = `
    SELECT id, host_id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count, message, trigger_value, threshold
    FROM alert_state
  `;
  const conditions: string[] = [];
  const params: string[] = [];

  if (activeOnly) {
    conditions.push('resolved_at IS NULL');
  }
  if (hostId) {
    conditions.push('host_id = ?');
    params.push(hostId);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY triggered_at DESC';

  return db.prepare(sql).all(...params) as AlertRow[];
}

const _dashboardCache: { data: any; key: string | null; db: Database.Database | null; time: number } = { data: null, key: null, db: null, time: 0 };
const DASHBOARD_CACHE_TTL = 30000; // 30 seconds

function getDashboard(db: Database.Database, onlineThresholdMinutes: number, showInternal: boolean = false): any {
  const cacheKey = `${onlineThresholdMinutes}:${showInternal}`;
  if (_dashboardCache.key === cacheKey && _dashboardCache.db === db && Date.now() - _dashboardCache.time < DASHBOARD_CACHE_TTL) {
    return _dashboardCache.data;
  }

  const hosts = getHosts(db, onlineThresholdMinutes);

  const allContainers = db.prepare(`
    SELECT cs.status, cs.labels
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h
      AND cs.container_name = latest.cn
      AND cs.collected_at = latest.max_at
    WHERE cs.collected_at > datetime('now', '-15 minutes')
  `).all() as ContainerStatusRow[];
  const filtered = showInternal ? allContainers : allContainers.filter(c => {
    if (!c.labels) return true;
    try { return JSON.parse(c.labels)['insightd.internal'] !== 'true'; } catch { return true; }
  });
  const containerCounts = { total: filtered.length, running: filtered.filter(c => c.status === 'running').length };

  const activeAlerts = db.prepare(
    'SELECT COUNT(*) as count FROM alert_state WHERE resolved_at IS NULL'
  ).get() as CountRow | undefined;
  const activeAlertsList = getAlerts(db, true).slice(0, 10);

  const diskWarnings = db.prepare(`
    SELECT COUNT(*) as count FROM disk_snapshots ds
    INNER JOIN (
      SELECT host_id as h, mount_point as mp, MAX(collected_at) as max_at
      FROM disk_snapshots GROUP BY host_id, mount_point
    ) latest ON ds.host_id = latest.h
      AND ds.mount_point = latest.mp
      AND ds.collected_at = latest.max_at
    WHERE ds.used_percent >= 85
  `).get() as CountRow | undefined;

  const updatesAvailable = db.prepare(`
    SELECT COUNT(DISTINCT uc.host_id || '/' || uc.container_name) as count
    FROM update_checks uc
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(checked_at) as max_at
      FROM update_checks GROUP BY host_id, container_name
    ) latest ON uc.host_id = latest.h
      AND uc.container_name = latest.cn
      AND uc.checked_at = latest.max_at
    WHERE uc.has_update = 1
  `).get() as CountRow | undefined;

  // Endpoint monitoring stats
  const endpointTotal = db.prepare('SELECT COUNT(*) as count FROM http_endpoints WHERE enabled = 1').get() as CountRow | undefined;
  const endpointsUp = db.prepare(`
    SELECT COUNT(DISTINCT hc.endpoint_id) as count FROM http_checks hc
    INNER JOIN (
      SELECT endpoint_id, MAX(checked_at) as max_at FROM http_checks GROUP BY endpoint_id
    ) latest ON hc.endpoint_id = latest.endpoint_id AND hc.checked_at = latest.max_at
    INNER JOIN http_endpoints he ON he.id = hc.endpoint_id AND he.enabled = 1
    WHERE hc.is_up = 1
  `).get() as CountRow | undefined;

  let groups: any[] = [];
  try {
    const groupQueries = require('./group-queries');
    groups = groupQueries.getGroups(db, showInternal);
  } catch { /* group queries not available */ }

  // 24h availability per container — only for containers still being reported.
  // Containers that have stopped reporting (deleted, filtered, etc.) are
  // excluded so they don't show as "0% uptime" in the dashboard.
  const availRows = db.prepare(`
    SELECT host_id, container_name, labels,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
    FROM container_snapshots
    WHERE collected_at >= datetime('now', '-1 day')
      AND EXISTS (
        SELECT 1 FROM container_snapshots cs2
        WHERE cs2.host_id = container_snapshots.host_id
          AND cs2.container_name = container_snapshots.container_name
          AND cs2.collected_at > datetime('now', '-15 minutes')
      )
    GROUP BY host_id, container_name
  `).all() as AvailabilityRow[];
  const availFiltered = showInternal ? availRows : availRows.filter(c => {
    if (!c.labels) return true;
    try { return JSON.parse(c.labels)['insightd.internal'] !== 'true'; } catch { return true; }
  });
  let totalSnapshots = 0, totalRunning = 0;
  const downContainers: Array<{ hostId: string; name: string; uptimePercent: number; downMinutes: number }> = [];
  for (const r of availFiltered) {
    totalSnapshots += r.total;
    totalRunning += r.running;
    const pct = Math.round((r.running / r.total) * 1000) / 10;
    if (pct < 100) {
      const downMinutes = Math.round((r.total - r.running) * 5);
      downContainers.push({ hostId: r.host_id, name: r.container_name, uptimePercent: pct, downMinutes });
    }
  }
  downContainers.sort((a, b) => a.uptimePercent - b.uptimePercent);
  const overallAvailability = totalSnapshots > 0 ? Math.round((totalRunning / totalSnapshots) * 1000) / 10 : null;

  const result = {
    hostCount: hosts.length,
    hostsOnline: hosts.filter(h => h.is_online).length,
    hostsOffline: hosts.filter(h => !h.is_online).length,
    totalContainers: containerCounts?.total || 0,
    containersRunning: containerCounts?.running || 0,
    containersDown: (containerCounts?.total || 0) - (containerCounts?.running || 0),
    activeAlerts: activeAlerts?.count || 0,
    activeAlertsList,
    diskWarnings: diskWarnings?.count || 0,
    updatesAvailable: updatesAvailable?.count || 0,
    endpointsTotal: endpointTotal?.count || 0,
    endpointsUp: endpointsUp?.count || 0,
    endpointsDown: (endpointTotal?.count || 0) - (endpointsUp?.count || 0),
    groups,
    systemHealthScore: getSystemHealthScore(db),
    topInsights: getTopInsights(db),
    availability: { overallPercent: overallAvailability, downContainers },
  };

  _dashboardCache.data = result;
  _dashboardCache.key = cacheKey;
  _dashboardCache.db = db;
  _dashboardCache.time = Date.now();
  return result;
}

function getSystemHealthScore(db: Database.Database): { score: number; factors: any; hostBreakdown: any[]; computedAt: string } | null {
  try {
    const row = db.prepare("SELECT score, factors, computed_at FROM health_scores WHERE entity_type = 'system' AND entity_id = 'system'").get() as HealthScoreRow | undefined;
    if (!row) return null;
    // Include per-host factor breakdowns so the frontend can explain the score
    const hostRows = db.prepare("SELECT entity_id, score, factors FROM health_scores WHERE entity_type = 'host'").all() as HealthScoreRow[];
    const hostBreakdown = hostRows.map(h => ({
      hostId: h.entity_id,
      score: h.score,
      factors: JSON.parse(h.factors),
    }));
    return { score: row.score, factors: JSON.parse(row.factors), hostBreakdown, computedAt: row.computed_at };
  } catch { return null; }
}

function getTopInsights(db: Database.Database): InsightRow[] {
  try {
    return db.prepare(`
      SELECT entity_type, entity_id, category, severity, title, message FROM insights
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
      LIMIT 5
    `).all() as InsightRow[];
  } catch { return []; }
}

function getLatestHostMetrics(db: Database.Database, hostId: string): HostMetricsRow | null {
  return db.prepare(`
    SELECT cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb,
           swap_total_mb, swap_used_mb, load_1, load_5, load_15, uptime_seconds,
           gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb,
           gpu_temperature_celsius, cpu_temperature_celsius,
           disk_read_bytes_per_sec, disk_write_bytes_per_sec,
           net_rx_bytes_per_sec, net_tx_bytes_per_sec, collected_at
    FROM host_snapshots WHERE host_id = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId) as HostMetricsRow | undefined || null;
}

function getHostMetricsHistory(db: Database.Database, hostId: string, hours: number): HostMetricsHistoryRow[] {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb,
           load_1, load_5, load_15,
           gpu_utilization_percent, gpu_temperature_celsius, cpu_temperature_celsius,
           disk_read_bytes_per_sec, disk_write_bytes_per_sec,
           net_rx_bytes_per_sec, net_tx_bytes_per_sec, collected_at
    FROM host_snapshots WHERE host_id = ? AND collected_at >= ${cutoff}
    ORDER BY collected_at ASC
  `).all(hostId) as HostMetricsHistoryRow[];
}

function getContainerHistory(db: Database.Database, hostId: string, containerName: string, hours: number): ContainerHistoryRow[] {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT status, cpu_percent, memory_mb, restart_count,
           network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes,
           health_status, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
      AND collected_at >= ${cutoff}
    ORDER BY collected_at ASC
  `).all(hostId, containerName) as ContainerHistoryRow[];
}

function getContainerAlerts(db: Database.Database, hostId: string, containerName: string): ContainerAlertRow[] {
  return db.prepare(`
    SELECT id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count, message, trigger_value, threshold
    FROM alert_state
    WHERE host_id = ? AND target = ?
    ORDER BY triggered_at DESC
  `).all(hostId, containerName) as ContainerAlertRow[];
}

function getContainerId(db: Database.Database, hostId: string, containerName: string): string | null {
  const row = db.prepare(`
    SELECT container_id FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId, containerName) as ContainerIdRow | undefined;
  return row?.container_id || null;
}

function getUptimeTimeline(db: Database.Database, hostId: string, days: number): Array<{ name: string; slots: string[]; uptimePercent: number | null }> {
  const rows = db.prepare(`
    SELECT container_name, status, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY container_name, collected_at
  `).all(hostId, days) as UptimeSnapshotRow[];

  const containers: Record<string, UptimeSnapshotRow[]> = {};
  for (const r of rows) {
    if (!containers[r.container_name]) containers[r.container_name] = [];
    containers[r.container_name].push(r);
  }

  const totalHours = days * 24;
  const now = Date.now();
  const startMs = now - days * 86400000;

  return Object.entries(containers).map(([name, snapshots]) => {
    const slots: string[] = [];
    let runningCount = 0;
    for (let h = 0; h < totalHours; h++) {
      const slotStart = startMs + h * 3600000;
      const slotEnd = slotStart + 3600000;
      const inSlot = snapshots.filter(s => {
        const t = new Date(s.collected_at + 'Z').getTime();
        return t >= slotStart && t < slotEnd;
      });
      if (inSlot.length === 0) {
        slots.push('none');
      } else if (inSlot.every(s => s.status === 'running')) {
        slots.push('up');
        runningCount++;
      } else {
        slots.push('down');
      }
    }
    const slotsWithData = slots.filter(s => s !== 'none').length;
    const uptimePercent = slotsWithData > 0 ? Math.round((runningCount / slotsWithData) * 100 * 10) / 10 : null;
    return { name, slots, uptimePercent };
  });
}

function getResourceRankings(db: Database.Database, limit: number): { byCpu: ResourceRow[]; byMemory: ResourceRow[] } {
  const query = `
    SELECT cs.host_id, cs.container_name, cs.cpu_percent, cs.memory_mb
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h AND cs.container_name = latest.cn AND cs.collected_at = latest.max_at
    WHERE cs.status = 'running'
  `;
  const byCpu = db.prepare(query + ' AND cs.cpu_percent IS NOT NULL ORDER BY cs.cpu_percent DESC LIMIT ?').all(limit) as ResourceRow[];
  const byMemory = db.prepare(query + ' AND cs.memory_mb IS NOT NULL ORDER BY cs.memory_mb DESC LIMIT ?').all(limit) as ResourceRow[];
  return { byCpu, byMemory };
}

function getTrends(db: Database.Database, hostId: string): { containers: any[]; host: any } {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
  const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');
  const nowStr = fmt(now);
  const thisWeek = fmt(weekAgo);
  const lastWeek = fmt(twoWeeksAgo);

  const containerTrends = db.prepare(`
    SELECT container_name,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as this_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as last_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_mb END) as this_mem,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_mb END) as last_mem
    FROM container_snapshots
    WHERE host_id = ? AND collected_at BETWEEN ? AND ?
    GROUP BY container_name
  `).all(thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, hostId, lastWeek, nowStr) as ContainerTrendRow[];

  const containers = containerTrends.map(r => {
    const cpuChange = r.last_cpu && r.this_cpu ? Math.round(((r.this_cpu - r.last_cpu) / r.last_cpu) * 100) : null;
    const memChange = r.last_mem && r.this_mem ? Math.round(((r.this_mem - r.last_mem) / r.last_mem) * 100) : null;
    return {
      name: r.container_name,
      cpuNow: r.this_cpu ? Math.round(r.this_cpu * 10) / 10 : null,
      cpuChange,
      memNow: r.this_mem ? Math.round(r.this_mem) : null,
      memChange,
      flagged: (cpuChange != null && Math.abs(cpuChange) > 10) || (memChange != null && Math.abs(memChange) > 10),
    };
  });

  const hostTrend = db.prepare(`
    SELECT
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as this_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN cpu_percent END) as last_cpu,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_used_mb END) as this_mem,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN memory_used_mb END) as last_mem,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN load_5 END) as this_load,
      AVG(CASE WHEN collected_at BETWEEN ? AND ? THEN load_5 END) as last_load
    FROM host_snapshots
    WHERE host_id = ? AND collected_at BETWEEN ? AND ?
  `).get(thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, hostId, lastWeek, nowStr) as HostTrendRow | undefined;

  let host: any = null;
  if (hostTrend && hostTrend.this_cpu != null) {
    const pctChange = (curr: number | null, prev: number | null): number | null => prev && curr ? Math.round(((curr - prev) / prev) * 100) : null;
    host = {
      cpuNow: hostTrend.this_cpu ? Math.round(hostTrend.this_cpu * 10) / 10 : null,
      cpuChange: pctChange(hostTrend.this_cpu, hostTrend.last_cpu),
      memNow: hostTrend.this_mem ? Math.round(hostTrend.this_mem) : null,
      memChange: pctChange(hostTrend.this_mem, hostTrend.last_mem),
      loadNow: hostTrend.this_load ? Math.round(hostTrend.this_load * 100) / 100 : null,
      loadChange: pctChange(hostTrend.this_load, hostTrend.last_load),
    };
  }

  return { containers, host };
}

function getEvents(db: Database.Database, hostId: string, days: number): Array<{ time: string; type: string; target: string; message: string; good: boolean }> {
  const events: Array<{ time: string; type: string; target: string; message: string; good: boolean }> = [];

  // Status changes
  const changes = db.prepare(`
    SELECT cs1.container_name, cs1.status as new_status, cs2.status as old_status, cs1.collected_at as time
    FROM container_snapshots cs1
    JOIN container_snapshots cs2 ON cs1.host_id = cs2.host_id
      AND cs1.container_name = cs2.container_name
      AND cs2.collected_at = (
        SELECT MAX(collected_at) FROM container_snapshots
        WHERE host_id = cs1.host_id AND container_name = cs1.container_name
          AND collected_at < cs1.collected_at
      )
    WHERE cs1.host_id = ? AND cs1.status != cs2.status
      AND cs1.collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY cs1.collected_at DESC
  `).all(hostId, days) as StatusChangeRow[];

  for (const c of changes) {
    const good = c.new_status === 'running';
    events.push({
      time: c.time,
      type: good ? 'container_started' : 'container_stopped',
      target: c.container_name,
      message: `${c.container_name} ${good ? 'started' : 'stopped'} (was ${c.old_status})`,
      good,
    });
  }

  // Alerts
  const alerts = db.prepare(`
    SELECT alert_type, target, triggered_at, resolved_at
    FROM alert_state
    WHERE host_id = ? AND triggered_at >= datetime('now', '-' || ? || ' days')
    ORDER BY triggered_at DESC
  `).all(hostId, days) as AlertEventRow[];

  for (const a of alerts) {
    events.push({
      time: a.triggered_at,
      type: 'alert_triggered',
      target: a.target,
      message: `Alert: ${a.alert_type.replace(/_/g, ' ')} — ${a.target}`,
      good: false,
    });
    if (a.resolved_at) {
      events.push({
        time: a.resolved_at,
        type: 'alert_resolved',
        target: a.target,
        message: `Resolved: ${a.alert_type.replace(/_/g, ' ')} — ${a.target}`,
        good: true,
      });
    }
  }

  // Sort newest first
  events.sort((a, b) => b.time.localeCompare(a.time));
  return events;
}

function getDiskForecast(db: Database.Database, hostId: string): Array<{ mountPoint: string; daysUntilFull: number | null; dailyGrowthGb: number; currentPercent?: number }> {
  const mounts = db.prepare(`
    SELECT DISTINCT mount_point FROM disk_snapshots WHERE host_id = ?
  `).all(hostId) as MountPointRow[];

  return mounts.map(({ mount_point }) => {
    const rows = db.prepare(`
      SELECT used_gb, total_gb, used_percent, collected_at
      FROM disk_snapshots
      WHERE host_id = ? AND mount_point = ?
        AND collected_at >= datetime('now', '-7 days')
      ORDER BY collected_at
    `).all(hostId, mount_point) as DiskForecastDataRow[];

    if (rows.length < 2) return { mountPoint: mount_point, daysUntilFull: null, dailyGrowthGb: 0 };

    // Linear regression: slope of used_gb over time
    const first = rows[0];
    const last = rows[rows.length - 1];
    const timeSpanDays = (new Date(last.collected_at + 'Z').getTime() - new Date(first.collected_at + 'Z').getTime()) / 86400000;
    if (timeSpanDays < 0.1) return { mountPoint: mount_point, daysUntilFull: null, dailyGrowthGb: 0 };

    const dailyGrowthGb = (last.used_gb - first.used_gb) / timeSpanDays;
    const remainingGb = last.total_gb - last.used_gb;

    let daysUntilFull: number | null = null;
    if (dailyGrowthGb > 0.001) {
      daysUntilFull = Math.round(remainingGb / dailyGrowthGb);
    }

    return { mountPoint: mount_point, daysUntilFull, dailyGrowthGb: Math.round(dailyGrowthGb * 1000) / 1000, currentPercent: last.used_percent };
  });
}

function getAllImageUpdates(db: Database.Database): ImageUpdateRow[] {
  return db.prepare(`
    SELECT uc.host_id, uc.container_name, uc.image, uc.checked_at
    FROM update_checks uc
    INNER JOIN (
      SELECT host_id, container_name, MAX(checked_at) as max_at
      FROM update_checks GROUP BY host_id, container_name
    ) latest ON uc.host_id = latest.host_id
      AND uc.container_name = latest.container_name
      AND uc.checked_at = latest.max_at
    WHERE uc.has_update = 1
    ORDER BY uc.host_id, uc.container_name
  `).all() as ImageUpdateRow[];
}

function getContainerDowntime(db: Database.Database, hostId: string, containerName: string, days: number): any {
  // Status transitions for this container
  const changes = db.prepare(`
    SELECT cs1.status as new_status, cs2.status as old_status, cs1.collected_at as time
    FROM container_snapshots cs1
    JOIN container_snapshots cs2 ON cs1.host_id = cs2.host_id
      AND cs1.container_name = cs2.container_name
      AND cs2.collected_at = (
        SELECT MAX(collected_at) FROM container_snapshots
        WHERE host_id = cs1.host_id AND container_name = cs1.container_name
          AND collected_at < cs1.collected_at
      )
    WHERE cs1.host_id = ? AND cs1.container_name = ?
      AND cs1.status != cs2.status
      AND cs1.collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY cs1.collected_at ASC
  `).all(hostId, containerName, days) as DowntimeChangeRow[];

  // Pair stop/start transitions into downtime incidents
  const incidents: Array<{ start: string; end: string | null; durationMs: number | null; ongoing: boolean }> = [];
  let currentDown: { start: string; end: string | null; durationMs: number | null; ongoing: boolean } | null = null;
  for (const c of changes) {
    if (c.new_status !== 'running' && !currentDown) {
      currentDown = { start: c.time, end: null, durationMs: null, ongoing: true };
    } else if (c.new_status === 'running' && currentDown) {
      currentDown.end = c.time;
      currentDown.durationMs = new Date(c.time + 'Z').getTime() - new Date(currentDown.start + 'Z').getTime();
      currentDown.ongoing = false;
      incidents.push(currentDown);
      currentDown = null;
    }
  }
  if (currentDown) incidents.push(currentDown);

  // Single-container timeline (same logic as getUptimeTimeline)
  const rows = db.prepare(`
    SELECT status, collected_at FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
      AND collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY collected_at
  `).all(hostId, containerName, days) as DowntimeSnapshotRow[];

  const totalHours = days * 24;
  const now = Date.now();
  const startMs = now - days * 86400000;
  const slots: string[] = [];
  let upCount = 0, downCount = 0;
  for (let h = 0; h < totalHours; h++) {
    const slotStart = startMs + h * 3600000;
    const slotEnd = slotStart + 3600000;
    const inSlot = rows.filter(s => {
      const t = new Date(s.collected_at + 'Z').getTime();
      return t >= slotStart && t < slotEnd;
    });
    if (inSlot.length === 0) {
      slots.push('none');
    } else if (inSlot.every(s => s.status === 'running')) {
      slots.push('up');
      upCount++;
    } else {
      slots.push('down');
      downCount++;
    }
  }
  const noDataCount = slots.filter(s => s === 'none').length;
  const slotsWithData = totalHours - noDataCount;
  const uptimePercent = slotsWithData > 0 ? Math.round((upCount / slotsWithData) * 1000) / 10 : null;

  return {
    timeline: { slots, uptimePercent, slotStartTime: startMs },
    incidents: incidents.reverse(),
    summary: { totalHours, upHours: upCount, downHours: downCount, noDataHours: noDataCount, uptimePercent },
  };
}

module.exports = { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestDisk, getLatestUpdates, getAlerts, getDashboard, getContainerHistory, getContainerAlerts, getLatestHostMetrics, getHostMetricsHistory, getContainerId, getUptimeTimeline, getResourceRankings, getTrends, getEvents, getDiskForecast, getAllImageUpdates, getContainerDowntime };
