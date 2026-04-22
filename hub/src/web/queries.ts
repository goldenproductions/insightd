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
  host_group: string | null;
  host_group_override: string | null;
  is_online: number;
}

interface HostDetailRow {
  host_id: string;
  first_seen: string;
  last_seen: string;
  runtime_type: string;
  host_group: string | null;
  host_group_override: string | null;
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
  health_check_output: string | null;
  labels: string | null;
  exit_code: number | null;
  collected_at: string;
  is_stale: number;
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
  silenced_until: string | null;
  silenced_by: string | null;
  silenced_at: string | null;
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
  evidence: string | null;
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
  silenced_until: string | null;
  silenced_by: string | null;
  silenced_at: string | null;
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
      COALESCE(host_group_override, host_group) AS host_group,
      host_group_override,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts ORDER BY host_id
  `).all(onlineThresholdMinutes) as HostRow[];
}

function getHostDetail(db: Database.Database, hostId: string, onlineThresholdMinutes: number, showInternal: boolean = false): any {
  const host = db.prepare(`
    SELECT host_id, first_seen, last_seen, runtime_type,
      COALESCE(host_group_override, host_group) AS host_group,
      host_group_override,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts WHERE host_id = ?
  `).get(onlineThresholdMinutes, hostId) as HostDetailRow | undefined;

  if (!host) return null;

  return {
    ...host,
    containers: getLatestContainers(db, hostId, onlineThresholdMinutes, showInternal),
    disk: getLatestDisk(db, hostId),
    alerts: getAlerts(db, true, hostId),
    updates: getLatestUpdates(db, hostId),
    hostMetrics: getLatestHostMetrics(db, hostId),
    diskForecast: getDiskForecast(db, hostId),
  };
}

function getLatestContainers(db: Database.Database, hostId: string, onlineThresholdMinutes: number, showInternal: boolean = false): ContainerRow[] {
  // Return the latest snapshot for every container currently present on the
  // host, per the `containers` registry. Containers whose latest batch no
  // longer lists them (Docker rm, k8s pod delete, completed Job pods) have
  // `removed_at` set by `ingestContainers` and are excluded here. Historical
  // snapshots stay in the DB for the timeline view.
  //
  // `is_stale=1` when the host hasn't reported within the offline threshold —
  // the snapshot below is the last known state, not current truth.
  const rows = db.prepare(`
    SELECT cs.container_name, cs.container_id, cs.status,
           cs.cpu_percent, cs.memory_mb, cs.restart_count,
           cs.network_rx_bytes, cs.network_tx_bytes, cs.blkio_read_bytes, cs.blkio_write_bytes,
           cs.health_status, cs.health_check_output, cs.labels, cs.exit_code, cs.collected_at,
           CASE WHEN datetime(h.last_seen, '+' || ? || ' minutes') > datetime('now')
             THEN 0 ELSE 1 END as is_stale
    FROM container_snapshots cs
    INNER JOIN containers c
      ON c.host_id = cs.host_id AND c.container_name = cs.container_name
    INNER JOIN hosts h ON h.host_id = cs.host_id
    INNER JOIN (
      SELECT host_id, container_name, MAX(collected_at) as max_at
      FROM container_snapshots WHERE host_id = ?
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.host_id
      AND cs.container_name = latest.container_name
      AND cs.collected_at = latest.max_at
    WHERE c.host_id = ? AND c.removed_at IS NULL
    ORDER BY cs.container_name
  `).all(onlineThresholdMinutes, hostId, hostId) as ContainerRow[];
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
    SELECT id, host_id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count, message, trigger_value, threshold, silenced_until, silenced_by, silenced_at
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

/**
 * Map `alert_type` to a severity "level". The design's Explore page groups
 * alerts into four levels — our data model has alert types, not levels, so
 * this derivation stays in one place.
 *
 * critical → something is down and users notice (container_down, host_offline, endpoint_down)
 * error    → persistent failure (container_unhealthy, restart_loop, disk_full)
 * warning  → resource pressure (high_cpu, high_memory, high_load, low_host_memory)
 * info     → everything else (room for future types)
 */
const LEVEL_BY_ALERT_TYPE: Record<string, 'critical' | 'error' | 'warning' | 'info'> = {
  container_down: 'critical',
  host_offline: 'critical',
  endpoint_down: 'critical',
  container_unhealthy: 'error',
  restart_loop: 'error',
  disk_full: 'error',
  high_cpu: 'warning',
  high_memory: 'warning',
  high_host_cpu: 'warning',
  low_host_memory: 'warning',
  high_load: 'warning',
};

/** The CASE expression equivalent of LEVEL_BY_ALERT_TYPE — used in SQL filters/facets. */
const LEVEL_CASE_SQL = `
  CASE alert_type
    WHEN 'container_down' THEN 'critical'
    WHEN 'host_offline' THEN 'critical'
    WHEN 'endpoint_down' THEN 'critical'
    WHEN 'container_unhealthy' THEN 'error'
    WHEN 'restart_loop' THEN 'error'
    WHEN 'disk_full' THEN 'error'
    WHEN 'high_cpu' THEN 'warning'
    WHEN 'high_memory' THEN 'warning'
    WHEN 'high_host_cpu' THEN 'warning'
    WHEN 'low_host_memory' THEN 'warning'
    WHEN 'high_load' THEN 'warning'
    ELSE 'info'
  END
`;

interface AlertsExploreFilters {
  /** Page size, clamped server-side to [1, 200]. */
  limit: number;
  offset: number;
  /** Filter to only active or only ended alerts. Omit for both. */
  status?: 'active' | 'resolved';
  /** OR'd across levels — empty list means "any level". */
  levels?: Array<'critical' | 'error' | 'warning' | 'info'>;
  /** OR'd across host_ids. */
  hosts?: string[];
  /** `true` = only silenced alerts, `false` = only not-silenced, undefined = both. */
  muted?: boolean;
  /** Case-insensitive substring match against alert_type, target, message, host_id. */
  q?: string;
}

interface AlertsExploreResult {
  total: number;
  alerts: Array<AlertRow & { level: string }>;
  counts: {
    byStatus: { active: number; resolved: number };
    byLevel: { critical: number; error: number; warning: number; info: number };
    byHost: Array<{ host_id: string; count: number }>;
    byMuted: { muted: number; not_muted: number };
  };
}

/**
 * Explore-style query for the Alerts page. Returns a page of alerts plus
 * *pre-filter* facet counts so the rail can show "how many match if I add
 * this filter" — consistent with Grafana / Explore-style UIs.
 */
function getAlertsExplore(db: Database.Database, filters: AlertsExploreFilters): AlertsExploreResult {
  const limit = Math.min(200, Math.max(1, filters.limit));
  const offset = Math.max(0, filters.offset);

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status === 'active') where.push('resolved_at IS NULL');
  else if (filters.status === 'resolved') where.push('resolved_at IS NOT NULL');

  if (filters.levels && filters.levels.length > 0) {
    where.push(`(${LEVEL_CASE_SQL}) IN (${filters.levels.map(() => '?').join(',')})`);
    params.push(...filters.levels);
  }

  if (filters.hosts && filters.hosts.length > 0) {
    where.push(`host_id IN (${filters.hosts.map(() => '?').join(',')})`);
    params.push(...filters.hosts);
  }

  if (filters.muted === true) where.push('silenced_until IS NOT NULL');
  else if (filters.muted === false) where.push('silenced_until IS NULL');

  if (filters.q && filters.q.trim()) {
    const needle = `%${filters.q.trim().toLowerCase()}%`;
    where.push(`(LOWER(alert_type) LIKE ? OR LOWER(target) LIKE ? OR LOWER(IFNULL(message, '')) LIKE ? OR LOWER(host_id) LIKE ?)`);
    params.push(needle, needle, needle, needle);
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM alert_state${whereSql}`).get(...params) as CountRow;

  const alerts = db.prepare(`
    SELECT id, host_id, alert_type, target, triggered_at, resolved_at, last_notified,
           notify_count, message, trigger_value, threshold,
           silenced_until, silenced_by, silenced_at,
           ${LEVEL_CASE_SQL} AS level
    FROM alert_state${whereSql}
    ORDER BY
      CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,
      triggered_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<AlertRow & { level: string }>;

  // Facet counts are computed unfiltered — the rail shows "how many exist of
  // each option", not "how many match the current filter". This matches the
  // standard Explore / Discover UX.
  const byStatus = { active: 0, resolved: 0 };
  const statusRows = db.prepare(`
    SELECT CASE WHEN resolved_at IS NULL THEN 'active' ELSE 'resolved' END AS k, COUNT(*) AS c
    FROM alert_state GROUP BY k
  `).all() as Array<{ k: 'active' | 'resolved'; c: number }>;
  for (const r of statusRows) byStatus[r.k] = r.c;

  const byLevel = { critical: 0, error: 0, warning: 0, info: 0 };
  const levelRows = db.prepare(`
    SELECT ${LEVEL_CASE_SQL} AS k, COUNT(*) AS c FROM alert_state GROUP BY k
  `).all() as Array<{ k: keyof typeof byLevel; c: number }>;
  for (const r of levelRows) if (r.k in byLevel) byLevel[r.k] = r.c;

  const byMuted = { muted: 0, not_muted: 0 };
  const mutedRows = db.prepare(`
    SELECT CASE WHEN silenced_until IS NULL THEN 'not_muted' ELSE 'muted' END AS k, COUNT(*) AS c
    FROM alert_state GROUP BY k
  `).all() as Array<{ k: 'muted' | 'not_muted'; c: number }>;
  for (const r of mutedRows) byMuted[r.k] = r.c;

  const byHost = db.prepare(`
    SELECT host_id, COUNT(*) AS count
    FROM alert_state
    GROUP BY host_id
    ORDER BY count DESC, host_id ASC
    LIMIT 20
  `).all() as Array<{ host_id: string; count: number }>;

  return { total: totalRow.count, alerts, counts: { byStatus, byLevel, byHost, byMuted } };
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
    INNER JOIN containers c
      ON c.host_id = cs.host_id AND c.container_name = cs.container_name
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h
      AND cs.container_name = latest.cn
      AND cs.collected_at = latest.max_at
    WHERE c.removed_at IS NULL
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

  // 24h availability per container — only for containers still present in
  // the registry. Two-pass to avoid a correlated EXISTS over the snapshot
  // table: first get the set of active (host,name) pairs, then aggregate
  // 24h stats filtered to that set.
  const activePairs = db.prepare(`
    SELECT host_id, container_name
    FROM containers
    WHERE removed_at IS NULL
  `).all() as Array<{ host_id: string; container_name: string }>;
  const availRows: AvailabilityRow[] = [];
  if (activePairs.length > 0) {
    // Skip containers whose latest snapshot is not 'running'. Mirrors the
    // filter in hub/src/insights/detector.ts (PR #125): a currently-stopped
    // container falls into one of three buckets, none of which want a
    // "downtime" item on the dashboard:
    //   1. Intentionally stopped (nginx/postgres/redis sitting exited for
    //      weeks on proxmox-01) — pure noise, inflates concernCount.
    //   2. Actively crashed — the container_unhealthy/container_down alert
    //      path surfaces it via activeAlertsList.
    //   3. Stopped moments ago — the alert will fire on the next evaluator
    //      tick. No need to double-report it here.
    // Only "was down briefly, is running again" is a legitimate entry in
    // the availability feed, and that requires the latest snapshot to be
    // running.
    const latestStatusStmt = db.prepare(`
      SELECT status FROM container_snapshots
      WHERE host_id = ? AND container_name = ?
      ORDER BY collected_at DESC LIMIT 1
    `);
    const availStmt = db.prepare(`
      SELECT labels,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM container_snapshots
      WHERE host_id = ? AND container_name = ?
        AND collected_at >= datetime('now', '-1 day')
    `);
    for (const pair of activePairs) {
      const latest = latestStatusStmt.get(pair.host_id, pair.container_name) as
        { status: string } | undefined;
      if (!latest || latest.status !== 'running') continue;
      const row = availStmt.get(pair.host_id, pair.container_name) as
        { labels: string | null; total: number; running: number } | undefined;
      if (row && row.total > 0) {
        availRows.push({
          host_id: pair.host_id,
          container_name: pair.container_name,
          labels: row.labels,
          total: row.total,
          running: row.running,
        });
      }
    }
  }
  const availFiltered = showInternal ? availRows : availRows.filter(c => {
    if (!c.labels) return true;
    try { return JSON.parse(c.labels)['insightd.internal'] !== 'true'; } catch { return true; }
  });
  // Per-container retrospective downtime used to surface here as an acute
  // "Downtime" row in the dashboard feed. That duplicated the `availability`
  // insight (same event, same container) in two columns, making recovered
  // dips look like active problems. The fleet-wide `overallPercent` still
  // needs the totals, but individual entries now live only in the Insights
  // feed via getTopInsights + the `had downtime` insight row.
  let totalSnapshots = 0, totalRunning = 0;
  for (const r of availFiltered) {
    totalSnapshots += r.total;
    totalRunning += r.running;
  }
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
    systemHealthScore: getSystemHealthScore(db),
    topInsights: getTopInsights(db),
    availability: { overallPercent: overallAvailability },
    recentActivity: getRecentActivity(db, 8),
  };

  _dashboardCache.data = result;
  _dashboardCache.key = cacheKey;
  _dashboardCache.db = db;
  _dashboardCache.time = Date.now();
  return result;
}

/**
 * Rescore a host's `alerts` factor against a live count. Mutates the
 * passed-in factors object and returns the re-weighted host score so the
 * displayed number actually matches the factors the user sees.
 *
 * The formula mirrors `computeHealthScores` in `hub/src/insights/health.ts`:
 * score = max(0, 100 - count * 20); rating buckets at 0, ≤2, >2.
 */
function patchAlertsFactor(factors: Record<string, any>, liveCount: number): number {
  const existing = factors.alerts;
  const weight = existing?.weight ?? 15;
  const score = Math.max(0, 100 - liveCount * 20);
  const rating = liveCount === 0 ? 'normal' : liveCount <= 2 ? 'elevated' : 'critical';
  factors.alerts = { score, weight, value: liveCount, rating };

  let total = 0;
  let totalWeight = 0;
  for (const key of Object.keys(factors)) {
    const f = factors[key];
    if (f && typeof f.score === 'number' && typeof f.weight === 'number') {
      total += f.score * f.weight;
      totalWeight += f.weight;
    }
  }
  return totalWeight > 0 ? Math.round(total / totalWeight) : 100;
}

function getSystemHealthScore(db: Database.Database): { score: number; factors: any; hostBreakdown: any[]; computedAt: string } | null {
  try {
    const row = db.prepare("SELECT score, factors, computed_at FROM health_scores WHERE entity_type = 'system' AND entity_id = 'system'").get() as HealthScoreRow | undefined;
    if (!row) return null;
    // Include per-host factor breakdowns so the frontend can explain the score.
    const hostRows = db.prepare("SELECT entity_id, score, factors FROM health_scores WHERE entity_type = 'host'").all() as HealthScoreRow[];

    // Alerts are volatile and the `health_scores` row is updated at most every
    // 15 minutes (and can be stale for longer right after a hub restart).
    // Re-run the aggregate here so the breakdown users see on the dashboard
    // matches what they'll see on the host detail page — no "2 alerts" here
    // vs "1 alert" there because a resolution landed between cron runs.
    const liveAlertRows = db.prepare(`
      SELECT host_id, COUNT(*) as c FROM alert_state
      WHERE resolved_at IS NULL
      GROUP BY host_id
    `).all() as Array<{ host_id: string; c: number }>;
    const liveAlertsByHost = new Map<string, number>(liveAlertRows.map(r => [r.host_id, r.c]));

    let anyHostChanged = false;
    const hostBreakdown = hostRows.map(h => {
      const factors = JSON.parse(h.factors) as Record<string, any>;
      let score = h.score;
      if (factors.alerts) {
        const liveCount = liveAlertsByHost.get(h.entity_id) ?? 0;
        if (liveCount !== factors.alerts.value) {
          score = patchAlertsFactor(factors, liveCount);
          anyHostChanged = true;
        }
      }
      return { hostId: h.entity_id, score, factors };
    });

    // If any host score shifted, recompute the system score from the patched
    // breakdown so the top-level number stays consistent with the factors.
    let systemScore = row.score;
    let systemFactors = JSON.parse(row.factors) as Record<string, any>;
    if (anyHostChanged && hostBreakdown.length > 0) {
      const scores = hostBreakdown.map(h => h.score);
      systemScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      systemFactors = { ...systemFactors, hostCount: scores.length, hostScores: scores };
    }

    return { score: systemScore, factors: systemFactors, hostBreakdown, computedAt: row.computed_at };
  } catch { return null; }
}

function getTopInsights(db: Database.Database): InsightRow[] {
  try {
    return db.prepare(`
      SELECT entity_type, entity_id, category, severity, title, message, evidence FROM insights
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
      LIMIT 5
    `).all() as InsightRow[];
  } catch { return []; }
}

interface RecentActivityRow {
  time: string;
  type: 'alert_triggered' | 'alert_resolved' | 'insight';
  host_id: string;
  target: string;
  message: string;
  tone: 'danger' | 'warning' | 'success' | 'info' | 'muted';
}

// Cross-fleet activity feed for the dashboard. Pulls alert fires,
// alert resolutions, and recent insights from the last 24h. Older items are
// ignored — recency matters more than count, and the design renders ~5 rows.
function getRecentActivity(db: Database.Database, limit: number): RecentActivityRow[] {
  const out: RecentActivityRow[] = [];

  try {
    const fires = db.prepare(`
      SELECT host_id, alert_type, target, triggered_at AS time, message
      FROM alert_state
      WHERE triggered_at >= datetime('now', '-1 day')
      ORDER BY triggered_at DESC
      LIMIT ?
    `).all(limit * 2) as Array<{ host_id: string; alert_type: string; target: string; time: string; message: string | null }>;
    for (const a of fires) {
      const tone: RecentActivityRow['tone'] = a.alert_type.includes('critical') || a.alert_type.includes('down') ? 'danger' : 'warning';
      out.push({
        time: a.time,
        type: 'alert_triggered',
        host_id: a.host_id,
        target: a.target,
        message: a.message ?? `${a.alert_type.replace(/_/g, ' ')} on ${a.target}`,
        tone,
      });
    }

    const resolves = db.prepare(`
      SELECT host_id, alert_type, target, resolved_at AS time
      FROM alert_state
      WHERE resolved_at IS NOT NULL AND resolved_at >= datetime('now', '-1 day')
      ORDER BY resolved_at DESC
      LIMIT ?
    `).all(limit * 2) as Array<{ host_id: string; alert_type: string; target: string; time: string }>;
    for (const r of resolves) {
      out.push({
        time: r.time,
        type: 'alert_resolved',
        host_id: r.host_id,
        target: r.target,
        message: `${r.alert_type.replace(/_/g, ' ')} resolved`,
        tone: 'success',
      });
    }
  } catch { /* alert_state may not exist on bootstrap */ }

  try {
    const insights = db.prepare(`
      SELECT entity_type, entity_id, category, severity, title, computed_at AS time
      FROM insights
      WHERE computed_at >= datetime('now', '-1 day')
      ORDER BY computed_at DESC
      LIMIT ?
    `).all(limit * 2) as Array<{ entity_type: string; entity_id: string; category: string; severity: string; title: string; time: string }>;
    for (const i of insights) {
      const hostId = i.entity_type === 'container' ? i.entity_id.split('/')[0] : i.entity_id;
      const tone: RecentActivityRow['tone'] = i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warning' : 'info';
      out.push({
        time: i.time,
        type: 'insight',
        host_id: hostId,
        target: i.entity_id,
        message: i.title,
        tone,
      });
    }
  } catch { /* insights may not exist on bootstrap */ }

  out.sort((a, b) => b.time.localeCompare(a.time));
  return out.slice(0, limit);
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
    SELECT id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count, message, trigger_value, threshold, silenced_until, silenced_by, silenced_at
    FROM alert_state
    WHERE host_id = ? AND target = ?
    ORDER BY triggered_at DESC
  `).all(hostId, containerName) as ContainerAlertRow[];
}

function getLatestContainer(db: Database.Database, hostId: string, containerName: string, onlineThresholdMinutes: number): ContainerRow | null {
  return (db.prepare(`
    SELECT cs.container_name, cs.container_id, cs.status,
           cs.cpu_percent, cs.memory_mb, cs.restart_count,
           cs.network_rx_bytes, cs.network_tx_bytes, cs.blkio_read_bytes, cs.blkio_write_bytes,
           cs.health_status, cs.health_check_output, cs.labels, cs.exit_code, cs.collected_at,
           CASE WHEN datetime(h.last_seen, '+' || ? || ' minutes') > datetime('now')
             THEN 0 ELSE 1 END as is_stale
    FROM container_snapshots cs
    INNER JOIN hosts h ON h.host_id = cs.host_id
    WHERE cs.host_id = ? AND cs.container_name = ?
    ORDER BY cs.collected_at DESC LIMIT 1
  `).get(onlineThresholdMinutes, hostId, containerName) as ContainerRow | undefined) ?? null;
}

function getContainerId(db: Database.Database, hostId: string, containerName: string): string | null {
  const row = db.prepare(`
    SELECT container_id FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId, containerName) as ContainerIdRow | undefined;
  return row?.container_id || null;
}

function getHostRuntimeType(db: Database.Database, hostId: string): string {
  const row = db.prepare('SELECT runtime_type FROM hosts WHERE host_id = ?')
    .get(hostId) as { runtime_type?: string } | undefined;
  return row?.runtime_type ?? 'docker';
}

function getUptimeTimeline(db: Database.Database, hostId: string, days: number): Array<{ name: string; slots: string[]; uptimePercent: number | null }> {
  const rows = db.prepare(`
    SELECT cs.container_name, cs.status, cs.collected_at
    FROM container_snapshots cs
    INNER JOIN containers c ON c.host_id = cs.host_id AND c.container_name = cs.container_name AND c.removed_at IS NULL
    WHERE cs.host_id = ? AND cs.collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY cs.container_name, cs.collected_at
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

function getResourceRankings(db: Database.Database, limit: number, showInternal: boolean = false): { byCpu: ResourceRow[]; byMemory: ResourceRow[] } {
  const query = `
    SELECT cs.host_id, cs.container_name, cs.cpu_percent, cs.memory_mb, cs.labels
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h AND cs.container_name = latest.cn AND cs.collected_at = latest.max_at
    WHERE cs.status = 'running'
  `;
  const rawByCpu = db.prepare(query + ' AND cs.cpu_percent IS NOT NULL ORDER BY cs.cpu_percent DESC LIMIT ?').all(limit * 4) as Array<ResourceRow & { labels: string | null }>;
  const rawByMemory = db.prepare(query + ' AND cs.memory_mb IS NOT NULL ORDER BY cs.memory_mb DESC LIMIT ?').all(limit * 4) as Array<ResourceRow & { labels: string | null }>;
  const filter = (rows: Array<ResourceRow & { labels: string | null }>): ResourceRow[] => {
    const filtered = showInternal ? rows : rows.filter(r => {
      if (!r.labels) return true;
      try { return JSON.parse(r.labels)['insightd.internal'] !== 'true'; } catch { return true; }
    });
    // Strip labels — callers don't need them in the ranking response.
    return filtered.slice(0, limit).map(({ labels: _labels, ...rest }) => rest);
  };
  return { byCpu: filter(rawByCpu), byMemory: filter(rawByMemory) };
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

  // Status changes — single pass with LAG window function. The previous
  // O(N²) correlated subquery took ~90s on hosts with thousands of snapshots.
  const changes = db.prepare(`
    SELECT container_name, new_status, old_status, time
    FROM (
      SELECT
        container_name,
        status AS new_status,
        LAG(status) OVER (PARTITION BY container_name ORDER BY collected_at) AS old_status,
        collected_at AS time
      FROM container_snapshots
      WHERE host_id = ?
        AND collected_at >= datetime('now', '-' || ? || ' days')
    )
    WHERE old_status IS NOT NULL AND new_status != old_status
    ORDER BY time DESC
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

interface DisksOverviewHostRow {
  host_id: string;
  host_group: string | null;
  is_online: number;
}

interface DisksOverviewMount {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
  collectedAt: string;
  daysUntilFull: number | null;
  dailyGrowthGb: number;
}

interface DisksOverviewHost {
  hostId: string;
  hostGroup: string | null;
  online: boolean;
  mounts: DisksOverviewMount[];
}

interface DisksOverviewWarning {
  hostId: string;
  mountPoint: string;
  severity: 'warning' | 'critical';
  reason: 'threshold' | 'forecast';
  usedPercent: number;
  daysUntilFull: number | null;
}

interface DisksOverviewResult {
  totals: { totalGb: number; usedGb: number; freeGb: number; usedPercent: number };
  hosts: DisksOverviewHost[];
  warnings: DisksOverviewWarning[];
}

function getDisksOverview(db: Database.Database, onlineThresholdMinutes: number): DisksOverviewResult {
  const hosts = db.prepare(`
    SELECT host_id,
      COALESCE(host_group_override, host_group) AS host_group,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts ORDER BY host_id
  `).all(onlineThresholdMinutes) as DisksOverviewHostRow[];

  const hostsOut: DisksOverviewHost[] = [];
  const warnings: DisksOverviewWarning[] = [];
  let totalGb = 0;
  let usedGb = 0;

  for (const h of hosts) {
    const mounts = getLatestDisk(db, h.host_id);
    if (mounts.length === 0) continue;

    const forecasts = getDiskForecast(db, h.host_id);
    const forecastByMount = new Map(forecasts.map(f => [f.mountPoint, f]));

    const mountsOut: DisksOverviewMount[] = mounts.map(m => {
      const f = forecastByMount.get(m.mount_point);
      const freeGb = Math.max(0, Math.round((m.total_gb - m.used_gb) * 100) / 100);
      return {
        mountPoint: m.mount_point,
        totalGb: m.total_gb,
        usedGb: m.used_gb,
        freeGb,
        usedPercent: m.used_percent,
        collectedAt: m.collected_at,
        daysUntilFull: f?.daysUntilFull ?? null,
        dailyGrowthGb: f?.dailyGrowthGb ?? 0,
      };
    });

    for (const m of mountsOut) {
      totalGb += m.totalGb;
      usedGb += m.usedGb;

      const thresholdCritical = m.usedPercent >= 90;
      const thresholdWarning = m.usedPercent >= 85;
      const forecastCritical = m.daysUntilFull != null && m.daysUntilFull < 7;
      const forecastWarning = m.daysUntilFull != null && m.daysUntilFull < 14;

      if (thresholdCritical || thresholdWarning || forecastCritical || forecastWarning) {
        const severity: 'warning' | 'critical' = (thresholdCritical || forecastCritical) ? 'critical' : 'warning';
        const reason: 'threshold' | 'forecast' = (thresholdCritical || thresholdWarning) ? 'threshold' : 'forecast';
        warnings.push({
          hostId: h.host_id,
          mountPoint: m.mountPoint,
          severity,
          reason,
          usedPercent: m.usedPercent,
          daysUntilFull: m.daysUntilFull,
        });
      }
    }

    hostsOut.push({
      hostId: h.host_id,
      hostGroup: h.host_group,
      online: h.is_online === 1,
      mounts: mountsOut,
    });
  }

  totalGb = Math.round(totalGb * 100) / 100;
  usedGb = Math.round(usedGb * 100) / 100;
  const freeGb = Math.round((totalGb - usedGb) * 100) / 100;
  const usedPercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 1000) / 10 : 0;

  warnings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return b.usedPercent - a.usedPercent;
  });

  return {
    totals: { totalGb, usedGb, freeGb, usedPercent },
    hosts: hostsOut,
    warnings,
  };
}

interface ContainerStorageRow {
  host_id: string;
  container_name: string;
  status: string;
  labels: string | null;
  collected_at: string;
  size_rootfs_bytes: number | null;
  size_rw_bytes: number | null;
  image: string | null;
  host_group: string | null;
  online: number;
}

interface ContainerStorageItem {
  name: string;
  image: string | null;
  status: string;
  sizeRwBytes: number | null;
  sizeRootfsBytes: number | null;
  collectedAt: string;
}

interface ContainersStorageHost {
  hostId: string;
  hostGroup: string | null;
  online: boolean;
  containers: ContainerStorageItem[];
}

interface ContainersStorageResult {
  totals: { containerCount: number; totalRwBytes: number; totalRootfsBytes: number };
  hosts: ContainersStorageHost[];
}

function getContainersStorage(
  db: Database.Database,
  onlineThresholdMinutes: number,
  showInternal: boolean = false,
): ContainersStorageResult {
  // Three CTEs: latest snapshot (for status/labels/collected_at), latest
  // snapshot *with sizes* (sticks around if the newest snapshot happened to
  // arrive without sizes), and latest image from update_checks.
  const rows = db.prepare(`
    WITH latest_meta AS (
      SELECT host_id, container_name, status, labels, collected_at,
             ROW_NUMBER() OVER (PARTITION BY host_id, container_name ORDER BY collected_at DESC) as rn
      FROM container_snapshots
    ),
    latest_sized AS (
      SELECT host_id, container_name, size_rootfs_bytes, size_rw_bytes,
             ROW_NUMBER() OVER (PARTITION BY host_id, container_name ORDER BY collected_at DESC) as rn
      FROM container_snapshots
      WHERE size_rootfs_bytes IS NOT NULL OR size_rw_bytes IS NOT NULL
    ),
    latest_image AS (
      SELECT host_id, container_name, image,
             ROW_NUMBER() OVER (PARTITION BY host_id, container_name ORDER BY checked_at DESC) as rn
      FROM update_checks
    )
    SELECT cn.host_id, cn.container_name,
           lm.status, lm.labels, lm.collected_at,
           ls.size_rootfs_bytes, ls.size_rw_bytes,
           li.image,
           COALESCE(h.host_group_override, h.host_group) AS host_group,
           CASE WHEN datetime(h.last_seen, '+' || ? || ' minutes') > datetime('now')
             THEN 1 ELSE 0 END AS online
    FROM containers cn
    INNER JOIN hosts h ON h.host_id = cn.host_id
    INNER JOIN latest_meta lm ON lm.host_id = cn.host_id AND lm.container_name = cn.container_name AND lm.rn = 1
    LEFT JOIN latest_sized ls ON ls.host_id = cn.host_id AND ls.container_name = cn.container_name AND ls.rn = 1
    LEFT JOIN latest_image li ON li.host_id = cn.host_id AND li.container_name = cn.container_name AND li.rn = 1
    WHERE cn.removed_at IS NULL
    ORDER BY cn.host_id,
             (ls.size_rw_bytes IS NULL) ASC, ls.size_rw_bytes DESC,
             (ls.size_rootfs_bytes IS NULL) ASC, ls.size_rootfs_bytes DESC,
             cn.container_name
  `).all(onlineThresholdMinutes) as ContainerStorageRow[];

  const filtered = showInternal ? rows : rows.filter(r => {
    if (!r.labels) return true;
    try { return JSON.parse(r.labels)['insightd.internal'] !== 'true'; } catch { return true; }
  });

  let totalRwBytes = 0;
  let totalRootfsBytes = 0;
  const byHost = new Map<string, ContainersStorageHost>();

  for (const r of filtered) {
    totalRwBytes += r.size_rw_bytes ?? 0;
    totalRootfsBytes += r.size_rootfs_bytes ?? 0;

    let h = byHost.get(r.host_id);
    if (!h) {
      h = { hostId: r.host_id, hostGroup: r.host_group, online: r.online === 1, containers: [] };
      byHost.set(r.host_id, h);
    }
    h.containers.push({
      name: r.container_name,
      image: r.image,
      status: r.status,
      sizeRwBytes: r.size_rw_bytes,
      sizeRootfsBytes: r.size_rootfs_bytes,
      collectedAt: r.collected_at,
    });
  }

  return {
    totals: {
      containerCount: filtered.length,
      totalRwBytes,
      totalRootfsBytes,
    },
    hosts: Array.from(byHost.values()),
  };
}

interface VolumeRow {
  host_id: string;
  volume_name: string;
  driver: string;
  mountpoint: string | null;
  size_bytes: number | null;
  ref_count: number | null;
  created_at: string | null;
  labels: string | null;
  collected_at: string;
}

interface VolumeHostRow {
  host_id: string;
  runtime_type: string;
  host_group: string | null;
  online: number;
}

interface VolumeItem {
  name: string;
  driver: string;
  mountpoint: string | null;
  sizeBytes: number | null;
  refCount: number | null;
  createdAt: string | null;
  collectedAt: string;
}

interface VolumesOverviewHost {
  hostId: string;
  runtimeType: string;
  hostGroup: string | null;
  online: boolean;
  volumes: VolumeItem[];
}

interface VolumesOverviewResult {
  totals: {
    volumeCount: number;
    totalSizeBytes: number;
    orphanedCount: number;
    orphanedSizeBytes: number;
  };
  hosts: VolumesOverviewHost[];
}

function getVolumesOverview(
  db: Database.Database,
  onlineThresholdMinutes: number,
): VolumesOverviewResult {
  const hosts = db.prepare(`
    SELECT host_id, runtime_type,
      COALESCE(host_group_override, host_group) AS host_group,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END AS online
    FROM hosts
    ORDER BY host_id
  `).all(onlineThresholdMinutes) as VolumeHostRow[];

  // Latest batch of volumes per host — agents publish a fresh inventory
  // every cycle, so the newest collected_at per host is authoritative.
  const vols = db.prepare(`
    WITH latest_batch AS (
      SELECT host_id, MAX(collected_at) AS max_at
      FROM volume_snapshots
      GROUP BY host_id
    )
    SELECT v.host_id, v.volume_name, v.driver, v.mountpoint,
           v.size_bytes, v.ref_count, v.created_at, v.labels, v.collected_at
    FROM volume_snapshots v
    INNER JOIN latest_batch lb
      ON lb.host_id = v.host_id AND v.collected_at = lb.max_at
    ORDER BY v.host_id,
             (v.size_bytes IS NULL) ASC, v.size_bytes DESC,
             v.volume_name
  `).all() as VolumeRow[];

  const byHost = new Map<string, VolumeItem[]>();
  for (const v of vols) {
    let list = byHost.get(v.host_id);
    if (!list) { list = []; byHost.set(v.host_id, list); }
    list.push({
      name: v.volume_name,
      driver: v.driver,
      mountpoint: v.mountpoint,
      sizeBytes: v.size_bytes,
      refCount: v.ref_count,
      createdAt: v.created_at,
      collectedAt: v.collected_at,
    });
  }

  let volumeCount = 0;
  let totalSizeBytes = 0;
  let orphanedCount = 0;
  let orphanedSizeBytes = 0;
  for (const list of byHost.values()) {
    for (const v of list) {
      volumeCount++;
      totalSizeBytes += v.sizeBytes ?? 0;
      if (v.refCount === 0) {
        orphanedCount++;
        orphanedSizeBytes += v.sizeBytes ?? 0;
      }
    }
  }

  return {
    totals: { volumeCount, totalSizeBytes, orphanedCount, orphanedSizeBytes },
    hosts: hosts.map(h => ({
      hostId: h.host_id,
      runtimeType: h.runtime_type,
      hostGroup: h.host_group,
      online: h.online === 1,
      volumes: byHost.get(h.host_id) ?? [],
    })),
  };
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

module.exports = { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestContainer, getLatestDisk, getLatestUpdates, getAlerts, getAlertsExplore, LEVEL_BY_ALERT_TYPE, getDashboard, getContainerHistory, getContainerAlerts, getLatestHostMetrics, getHostMetricsHistory, getContainerId, getHostRuntimeType, getUptimeTimeline, getResourceRankings, getTrends, getEvents, getDiskForecast, getDisksOverview, getContainersStorage, getVolumesOverview, getAllImageUpdates, getContainerDowntime };
