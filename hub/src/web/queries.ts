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
  cpu_limit_cores: number | null;
  cpu_limit_percent: number | null;
  memory_limit_mb: number | null;
  memory_limit_percent: number | null;
  last_oom_killed_at: string | null;
  size_rootfs_bytes: number | null;
  size_rw_bytes: number | null;
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
  exit_code: number | null;
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
  cpu_limit_cores: number | null;
  cpu_limit_percent: number | null;
  memory_limit_mb: number | null;
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
  exit_code: number | null;
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
  exit_code: number | null;
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

function getHostDetail(db: Database.Database, hostId: string, onlineThresholdMinutes: number): any {
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
    containers: getLatestContainers(db, hostId, onlineThresholdMinutes),
    disk: getLatestDisk(db, hostId),
    alerts: getAlerts(db, true, hostId),
    updates: getLatestUpdates(db, hostId),
    hostMetrics: getLatestHostMetrics(db, hostId),
    diskForecast: getDiskForecast(db, hostId),
    // K8s-only — empty array for Docker hosts. Embedded here so the detail
    // page badge row doesn't need a second round-trip.
    nodeConditions: host.runtime_type === 'kubernetes' ? getNodeConditionsForHost(db, hostId) : [],
  };
}

function getLatestContainers(db: Database.Database, hostId: string, onlineThresholdMinutes: number): ContainerRow[] {
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
           cs.cpu_limit_cores, cs.cpu_limit_percent, cs.memory_limit_mb,
           cs.size_rootfs_bytes, cs.size_rw_bytes,
           CASE WHEN cs.memory_limit_mb > 0 AND cs.memory_mb IS NOT NULL
             THEN ROUND(cs.memory_mb / cs.memory_limit_mb * 100, 1) END AS memory_limit_percent,
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
  return rows;
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
  node_not_ready: 'critical',
  cert_expired: 'critical',
  workload_unavailable: 'critical',
  container_unhealthy: 'error',
  restart_loop: 'error',
  disk_full: 'error',
  node_pressure: 'error',
  container_memory_saturation: 'error',
  cert_invalid: 'error',
  pod_pending: 'error',
  workload_degraded: 'error',
  high_cpu: 'warning',
  high_memory: 'warning',
  high_host_cpu: 'warning',
  low_host_memory: 'warning',
  high_load: 'warning',
  container_cpu_saturation: 'warning',
  cert_expiring_soon: 'warning',
  workload_rollout_stuck: 'warning',
};

/** The CASE expression equivalent of LEVEL_BY_ALERT_TYPE — used in SQL filters/facets. */
const LEVEL_CASE_SQL = `
  CASE alert_type
    WHEN 'container_down' THEN 'critical'
    WHEN 'host_offline' THEN 'critical'
    WHEN 'endpoint_down' THEN 'critical'
    WHEN 'node_not_ready' THEN 'critical'
    WHEN 'cert_expired' THEN 'critical'
    WHEN 'workload_unavailable' THEN 'critical'
    WHEN 'container_unhealthy' THEN 'error'
    WHEN 'restart_loop' THEN 'error'
    WHEN 'disk_full' THEN 'error'
    WHEN 'node_pressure' THEN 'error'
    WHEN 'container_memory_saturation' THEN 'error'
    WHEN 'cert_invalid' THEN 'error'
    WHEN 'pod_pending' THEN 'error'
    WHEN 'workload_degraded' THEN 'error'
    WHEN 'high_cpu' THEN 'warning'
    WHEN 'high_memory' THEN 'warning'
    WHEN 'high_host_cpu' THEN 'warning'
    WHEN 'low_host_memory' THEN 'warning'
    WHEN 'high_load' THEN 'warning'
    WHEN 'container_cpu_saturation' THEN 'warning'
    WHEN 'cert_expiring_soon' THEN 'warning'
    WHEN 'workload_rollout_stuck' THEN 'warning'
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
  /** OR'd across Kubernetes namespaces (derived from the prefix of `target`). */
  namespaces?: string[];
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
    byNamespace: Array<{ namespace: string; count: number }>;
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

  // Snapshot the non-namespace filter state so `byNamespace` can be computed
  // against everything *except* its own filter (standard facet-counts pattern).
  const preNsWhere = where.slice();
  const preNsParams = params.slice();

  if (filters.namespaces && filters.namespaces.length > 0) {
    where.push(`(instr(target, '/') > 1 AND substr(target, 1, instr(target, '/') - 1) IN (${filters.namespaces.map(() => '?').join(',')}))`);
    params.push(...filters.namespaces);
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

  // Namespace facet — computed with every OTHER active filter applied (but not
  // the namespace filter itself), so selecting a namespace doesn't zero out
  // its own count. Only k8s targets (containing '/') contribute.
  const preNsWhereParts = preNsWhere.slice();
  preNsWhereParts.push(`instr(target, '/') > 1`);
  const nsWhereSql = ` WHERE ${preNsWhereParts.join(' AND ')}`;
  const byNamespace = db.prepare(`
    SELECT substr(target, 1, instr(target, '/') - 1) AS namespace, COUNT(*) AS count
    FROM alert_state${nsWhereSql}
    GROUP BY namespace
    ORDER BY count DESC, namespace ASC
    LIMIT 20
  `).all(...preNsParams) as Array<{ namespace: string; count: number }>;

  return { total: totalRow.count, alerts, counts: { byStatus, byLevel, byHost, byNamespace, byMuted } };
}

const _dashboardCache: { data: any; key: string | null; db: Database.Database | null; time: number } = { data: null, key: null, db: null, time: 0 };
const DASHBOARD_CACHE_TTL = 30000; // 30 seconds

function getDashboard(db: Database.Database, onlineThresholdMinutes: number): any {
  const cacheKey = `${onlineThresholdMinutes}`;
  if (_dashboardCache.key === cacheKey && _dashboardCache.db === db && Date.now() - _dashboardCache.time < DASHBOARD_CACHE_TTL) {
    return _dashboardCache.data;
  }

  const hosts = getHosts(db, onlineThresholdMinutes);

  const allContainers = db.prepare(`
    SELECT cs.status, cs.exit_code
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
  // "Completed" = clean one-shot exit. Init containers (insightd-bootstrap,
  // migration sidecars, k8s Job pods) sit in this state forever and aren't
  // outages. We exclude them from the "down" count so the dashboard doesn't
  // false-flag them.
  const containerCounts = {
    total: allContainers.length,
    running: allContainers.filter(c => c.status === 'running').length,
    completed: allContainers.filter(c => c.status === 'exited' && c.exit_code === 0).length,
  };

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
  // Per-container retrospective downtime used to surface here as an acute
  // "Downtime" row in the dashboard feed. That duplicated the `availability`
  // insight (same event, same container) in two columns, making recovered
  // dips look like active problems. The fleet-wide `overallPercent` still
  // needs the totals, but individual entries now live only in the Insights
  // feed via getTopInsights + the `had downtime` insight row.
  let totalSnapshots = 0, totalRunning = 0;
  for (const r of availRows) {
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
    containersDown: (containerCounts?.total || 0) - (containerCounts?.running || 0) - (containerCounts?.completed || 0),
    containersCompleted: containerCounts?.completed || 0,
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
           health_status, cpu_limit_cores, cpu_limit_percent, memory_limit_mb,
           collected_at
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
           cs.cpu_limit_cores, cs.cpu_limit_percent, cs.memory_limit_mb,
           cs.size_rootfs_bytes, cs.size_rw_bytes,
           cs.last_oom_killed_at,
           cs.workload_kind, cs.pod_ip, cs.host_ip, cs.pod_conditions,
           CASE WHEN cs.memory_limit_mb > 0 AND cs.memory_mb IS NOT NULL
             THEN ROUND(cs.memory_mb / cs.memory_limit_mb * 100, 1) END AS memory_limit_percent,
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

/**
 * Latest image string for a container, sourced from the most recent
 * update_checks row. Returns null if the agent hasn't reported one yet
 * (some k8s containers — e.g. distroless or images without registry tags
 * — never produce an update_checks row).
 */
function getContainerImage(db: Database.Database, hostId: string, containerName: string): string | null {
  const row = db.prepare(`
    SELECT image FROM update_checks
    WHERE host_id = ? AND container_name = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(hostId, containerName) as { image?: string } | undefined;
  return row?.image ?? null;
}

function getHostRuntimeType(db: Database.Database, hostId: string): string {
  const row = db.prepare('SELECT runtime_type FROM hosts WHERE host_id = ?')
    .get(hostId) as { runtime_type?: string } | undefined;
  return row?.runtime_type ?? 'docker';
}

interface UptimeTimelineRow { name: string; slots: string[]; uptimePercent: number | null }

function getUptimeTimeline(db: Database.Database, hostId: string, days: number): { host: UptimeTimelineRow | null; containers: UptimeTimelineRow[] } {
  const totalHours = days * 24;
  const now = Date.now();
  const startMs = now - days * 86400000;

  const rows = db.prepare(`
    SELECT cs.container_name, cs.status, cs.exit_code, cs.collected_at
    FROM container_snapshots cs
    INNER JOIN containers c ON c.host_id = cs.host_id AND c.container_name = cs.container_name AND c.removed_at IS NULL
    WHERE cs.host_id = ? AND cs.collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY cs.container_name, cs.collected_at
  `).all(hostId, days) as UptimeSnapshotRow[];

  const containerMap: Record<string, UptimeSnapshotRow[]> = {};
  for (const r of rows) {
    if (!containerMap[r.container_name]) containerMap[r.container_name] = [];
    containerMap[r.container_name].push(r);
  }

  const containers = Object.entries(containerMap).map(([name, snapshots]) => {
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
      } else if (inSlot.every(s => s.status === 'exited' && s.exit_code === 0)) {
        // One-shot init container (insightd-bootstrap, migration sidecar,
        // k8s Job pod). Don't paint a red bar — it cleanly completed.
        slots.push('completed');
      } else {
        slots.push('down');
      }
    }
    // Completed slots are excluded from the uptime denominator: a container
    // that only ever ran once and exited 0 has no meaningful "uptime %".
    const slotsWithData = slots.filter(s => s !== 'none' && s !== 'completed').length;
    const uptimePercent = slotsWithData > 0 ? Math.round((runningCount / slotsWithData) * 100 * 10) / 10 : null;
    return { name, slots, uptimePercent };
  });

  // Host uptime: any host_snapshot in a slot ⇒ host was reporting (up).
  // No snapshot ⇒ either host was offline or the agent/hub couldn't reach it.
  const hostSnapshots = db.prepare(`
    SELECT collected_at FROM host_snapshots
    WHERE host_id = ? AND collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY collected_at
  `).all(hostId, days) as { collected_at: string }[];
  const hostExists = db.prepare('SELECT 1 FROM hosts WHERE host_id = ?').get(hostId);

  let host: UptimeTimelineRow | null = null;
  if (hostExists) {
    const hostTs = hostSnapshots.map(s => new Date(s.collected_at + 'Z').getTime());
    const slots: string[] = [];
    let upCount = 0;
    let firstSlotWithDataIdx = -1;
    for (let h = 0; h < totalHours; h++) {
      const slotStart = startMs + h * 3600000;
      const slotEnd = slotStart + 3600000;
      const hasSnapshot = hostTs.some(t => t >= slotStart && t < slotEnd);
      if (hasSnapshot) {
        slots.push('up');
        upCount++;
        if (firstSlotWithDataIdx === -1) firstSlotWithDataIdx = h;
      } else {
        slots.push(firstSlotWithDataIdx === -1 ? 'none' : 'down');
      }
    }
    const slotsWithData = slots.filter(s => s !== 'none').length;
    const uptimePercent = slotsWithData > 0 ? Math.round((upCount / slotsWithData) * 100 * 10) / 10 : null;
    host = { name: hostId, slots, uptimePercent };
  }

  return { host, containers };
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

// ───────────────────────── Kubernetes PV / PVC overview ─────────────────────────

interface PvRow {
  cluster_id: string;
  pv_name: string;
  phase: string;
  capacity_bytes: number | null;
  access_modes: string | null;
  reclaim_policy: string | null;
  storage_class: string | null;
  volume_mode: string | null;
  claim_namespace: string | null;
  claim_name: string | null;
  csi_driver: string | null;
  created_at: string | null;
  collected_at: string;
}

interface PvcRow {
  cluster_id: string;
  namespace: string;
  pvc_name: string;
  phase: string;
  storage_class: string | null;
  request_bytes: number | null;
  capacity_bytes: number | null;
  access_modes: string | null;
  volume_name: string | null;
  volume_mode: string | null;
  created_at: string | null;
  collected_at: string;
}

interface PvcItem {
  namespace: string;
  name: string;
  phase: string;
  storageClass: string | null;
  requestBytes: number | null;
  capacityBytes: number | null;
  accessModes: string[];
  volumeName: string | null;
  volumeMode: string | null;
  createdAt: string | null;
}

interface PvItem {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimRef: { namespace: string; name: string } | null;
  csiDriver: string | null;
  createdAt: string | null;
  boundPvc: PvcItem | null;
  orphaned: boolean;
}

interface PvsOverviewCluster {
  clusterId: string;
  online: boolean;                  // any data within stale window?
  lastCollectedAt: string | null;
  pvs: PvItem[];
  pvcs: PvcItem[];
}

interface PvsOverviewResult {
  totals: {
    pvCount: number;
    boundCount: number;
    availableCount: number;
    releasedCount: number;
    failedCount: number;
    totalCapacityBytes: number;
    orphanedCount: number;
    orphanedCapacityBytes: number;
    pvcCount: number;
    pvcPendingCount: number;
    clusterCount: number;
  };
  clusters: PvsOverviewCluster[];
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}

/**
 * Aggregate PV + PVC inventory across all clusters. Each cluster's latest
 * batch (newest collected_at) is used as authoritative — agents publish a
 * fresh inventory every cycle, so older rows naturally age out.
 *
 * `staleMinutes` controls when a cluster is considered offline (no fresh
 * publication within the window).
 */
function getPvsOverview(
  db: Database.Database,
  staleMinutes: number = 15,
): PvsOverviewResult {
  const pvs = db.prepare(`
    WITH latest_batch AS (
      SELECT cluster_id, MAX(collected_at) AS max_at
      FROM pv_snapshots
      GROUP BY cluster_id
    )
    SELECT p.cluster_id, p.pv_name, p.phase, p.capacity_bytes, p.access_modes,
           p.reclaim_policy, p.storage_class, p.volume_mode,
           p.claim_namespace, p.claim_name, p.csi_driver,
           p.created_at, p.collected_at
    FROM pv_snapshots p
    INNER JOIN latest_batch lb
      ON lb.cluster_id = p.cluster_id AND p.collected_at = lb.max_at
    ORDER BY p.cluster_id,
             (p.capacity_bytes IS NULL) ASC, p.capacity_bytes DESC,
             p.pv_name
  `).all() as PvRow[];

  const pvcs = db.prepare(`
    WITH latest_batch AS (
      SELECT cluster_id, MAX(collected_at) AS max_at
      FROM pvc_snapshots
      GROUP BY cluster_id
    )
    SELECT p.cluster_id, p.namespace, p.pvc_name, p.phase, p.storage_class,
           p.request_bytes, p.capacity_bytes, p.access_modes,
           p.volume_name, p.volume_mode, p.created_at, p.collected_at
    FROM pvc_snapshots p
    INNER JOIN latest_batch lb
      ON lb.cluster_id = p.cluster_id AND p.collected_at = lb.max_at
    ORDER BY p.cluster_id, p.namespace, p.pvc_name
  `).all() as PvcRow[];

  // Index PVCs by (cluster, namespace, name) for the PV→PVC join
  const pvcByKey = new Map<string, PvcItem>();
  const pvcsByCluster = new Map<string, PvcItem[]>();
  const lastSeenByCluster = new Map<string, string>();
  for (const r of pvcs) {
    const item: PvcItem = {
      namespace: r.namespace,
      name: r.pvc_name,
      phase: r.phase,
      storageClass: r.storage_class,
      requestBytes: r.request_bytes,
      capacityBytes: r.capacity_bytes,
      accessModes: safeJsonArray(r.access_modes),
      volumeName: r.volume_name,
      volumeMode: r.volume_mode,
      createdAt: r.created_at,
    };
    pvcByKey.set(`${r.cluster_id}/${r.namespace}/${r.pvc_name}`, item);
    let list = pvcsByCluster.get(r.cluster_id);
    if (!list) { list = []; pvcsByCluster.set(r.cluster_id, list); }
    list.push(item);
    const prev = lastSeenByCluster.get(r.cluster_id);
    if (!prev || r.collected_at > prev) lastSeenByCluster.set(r.cluster_id, r.collected_at);
  }

  const pvsByCluster = new Map<string, PvItem[]>();
  let pvCount = 0;
  let boundCount = 0, availableCount = 0, releasedCount = 0, failedCount = 0;
  let totalCapacityBytes = 0;
  let orphanedCount = 0, orphanedCapacityBytes = 0;
  for (const r of pvs) {
    const orphaned = r.phase === 'Released';
    const cap = r.capacity_bytes ?? 0;
    pvCount++;
    totalCapacityBytes += cap;
    if (r.phase === 'Bound')          boundCount++;
    else if (r.phase === 'Available') availableCount++;
    else if (r.phase === 'Released')  releasedCount++;
    else if (r.phase === 'Failed')    failedCount++;
    if (orphaned) { orphanedCount++; orphanedCapacityBytes += cap; }

    const boundPvc = (r.claim_namespace && r.claim_name)
      ? pvcByKey.get(`${r.cluster_id}/${r.claim_namespace}/${r.claim_name}`) ?? null
      : null;
    const item: PvItem = {
      name: r.pv_name,
      phase: r.phase,
      capacityBytes: r.capacity_bytes,
      accessModes: safeJsonArray(r.access_modes),
      reclaimPolicy: r.reclaim_policy,
      storageClass: r.storage_class,
      volumeMode: r.volume_mode,
      claimRef: (r.claim_namespace && r.claim_name)
        ? { namespace: r.claim_namespace, name: r.claim_name } : null,
      csiDriver: r.csi_driver,
      createdAt: r.created_at,
      boundPvc,
      orphaned,
    };
    let list = pvsByCluster.get(r.cluster_id);
    if (!list) { list = []; pvsByCluster.set(r.cluster_id, list); }
    list.push(item);
    const prev = lastSeenByCluster.get(r.cluster_id);
    if (!prev || r.collected_at > prev) lastSeenByCluster.set(r.cluster_id, r.collected_at);
  }

  const clusterIds = new Set<string>([...pvsByCluster.keys(), ...pvcsByCluster.keys()]);
  const staleCutoffMs = Date.now() - staleMinutes * 60_000;
  const clusters: PvsOverviewCluster[] = [];
  for (const clusterId of [...clusterIds].sort()) {
    const last = lastSeenByCluster.get(clusterId) ?? null;
    const lastMs = last ? Date.parse(last + 'Z') : 0;
    clusters.push({
      clusterId,
      online: lastMs >= staleCutoffMs,
      lastCollectedAt: last,
      pvs: pvsByCluster.get(clusterId) ?? [],
      pvcs: pvcsByCluster.get(clusterId) ?? [],
    });
  }

  let pvcCount = 0, pvcPendingCount = 0;
  for (const list of pvcsByCluster.values()) {
    for (const p of list) {
      pvcCount++;
      if (p.phase === 'Pending') pvcPendingCount++;
    }
  }

  return {
    totals: {
      pvCount, boundCount, availableCount, releasedCount, failedCount,
      totalCapacityBytes, orphanedCount, orphanedCapacityBytes,
      pvcCount, pvcPendingCount,
      clusterCount: clusters.length,
    },
    clusters,
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
    SELECT status, exit_code, collected_at FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
      AND collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY collected_at
  `).all(hostId, containerName, days) as DowntimeSnapshotRow[];

  const totalHours = days * 24;
  const now = Date.now();
  const startMs = now - days * 86400000;
  const slots: string[] = [];
  let upCount = 0, downCount = 0, completedCount = 0;
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
    } else if (inSlot.every(s => s.status === 'exited' && s.exit_code === 0)) {
      slots.push('completed');
      completedCount++;
    } else {
      slots.push('down');
      downCount++;
    }
  }
  const noDataCount = slots.filter(s => s === 'none').length;
  // Same rule as getUptimeTimeline: completed slots don't drag the % down.
  const slotsWithData = totalHours - noDataCount - completedCount;
  const uptimePercent = slotsWithData > 0 ? Math.round((upCount / slotsWithData) * 1000) / 10 : null;

  return {
    timeline: { slots, uptimePercent, slotStartTime: startMs },
    incidents: incidents.reverse(),
    summary: { totalHours, upHours: upCount, downHours: downCount, completedHours: completedCount, noDataHours: noDataCount, uptimePercent },
  };
}

export interface K8sEventRow {
  event_uid: string;
  cluster_id: string;
  namespace: string | null;
  involved_kind: string;
  involved_name: string;
  reason: string;
  message: string | null;
  type: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Resolve the cluster_id for a given host. Mirrors the agent logic
 * (agent/src/scheduler.ts: `clusterId = hostGroup || "cluster-{hostId}"`),
 * but UI overrides of host_group are honored via COALESCE.
 * Returns null for non-k8s hosts so the UI can show an empty state.
 */
function getClusterIdForHost(db: Database.Database, hostId: string): string | null {
  const row = db.prepare(`
    SELECT runtime_type,
           COALESCE(host_group_override, host_group) AS effective_group
    FROM hosts
    WHERE host_id = ?
  `).get(hostId) as { runtime_type: string | null; effective_group: string | null } | undefined;
  if (!row || row.runtime_type !== 'kubernetes') return null;
  return row.effective_group && row.effective_group.length > 0
    ? row.effective_group
    : `cluster-${hostId}`;
}

/**
 * K8s events scoped to a single pod / its parent workload. Pulled from the
 * already-ingested cluster-wide `k8s_events` table.
 *
 * The container_name format for k8s entities is "namespace/stable/container",
 * where `stable` is the workload identity resolved by the agent (Deployment
 * name for RS-owned pods, pod name for StatefulSet, controller name for
 * DaemonSet/Job). We match three event scopes:
 *
 *   1. Pod-level: involved_kind='Pod' AND involved_name LIKE 'stable%' —
 *      the trailing % catches both the deterministic StatefulSet names
 *      (exact match) and the random-suffix names of Deployment-owned pods.
 *   2. Direct workload: involved_kind IN (Deployment/StatefulSet/DaemonSet/
 *      Job/CronJob) AND involved_name = 'stable'.
 *   3. ReplicaSet: involved_kind='ReplicaSet' AND involved_name LIKE 'stable-%'
 *      — Deployment-owned RSes are named `<deployment>-<hash>`, so this
 *      catches them without bleeding across deployments.
 *
 * Returns [] for non-k8s containers and for cases where parsing fails.
 */
function getPodEvents(db: Database.Database, hostId: string, containerName: string, limit: number = 20): K8sEventRow[] {
  const clusterId = getClusterIdForHost(db, hostId);
  if (!clusterId) return [];

  const firstSlash = containerName.indexOf('/');
  if (firstSlash <= 0) return [];
  const namespace = containerName.slice(0, firstSlash);
  const rest = containerName.slice(firstSlash + 1);
  const secondSlash = rest.indexOf('/');
  // No second slash → container_name is just "namespace/pod" with no
  // container component. Still usable: stable = pod name.
  const stable = secondSlash > 0 ? rest.slice(0, secondSlash) : rest;
  if (!namespace || !stable) return [];

  const lim = Math.max(1, Math.min(100, limit));
  return db.prepare(`
    SELECT event_uid, cluster_id, namespace, involved_kind, involved_name,
           reason, message, type, count, first_seen_at, last_seen_at
    FROM k8s_events
    WHERE cluster_id = ? AND namespace = ?
      AND (
        (involved_kind = 'Pod'        AND involved_name LIKE ?)
        OR (involved_kind IN ('Deployment','StatefulSet','DaemonSet','Job','CronJob')
            AND involved_name = ?)
        OR (involved_kind = 'ReplicaSet' AND involved_name LIKE ?)
      )
    ORDER BY last_seen_at DESC
    LIMIT ${lim}
  `).all(clusterId, namespace, `${stable}%`, stable, `${stable}-%`) as K8sEventRow[];
}

interface K8sEventFilters {
  limit?: number;
  reason?: string;
  namespace?: string;
  sinceHours?: number;
}

function getK8sEventsForHost(db: Database.Database, hostId: string, filters: K8sEventFilters = {}): K8sEventRow[] {
  const clusterId = getClusterIdForHost(db, hostId);
  if (!clusterId) return [];

  const conditions: string[] = ['cluster_id = ?'];
  const params: any[] = [clusterId];

  if (filters.reason) {
    conditions.push('reason = ?');
    params.push(filters.reason);
  }
  if (filters.namespace) {
    conditions.push('namespace = ?');
    params.push(filters.namespace);
  }
  if (filters.sinceHours && filters.sinceHours > 0) {
    conditions.push(`last_seen_at >= datetime('now', '-${Math.floor(filters.sinceHours)} hours')`);
  }

  const limit = Math.max(1, Math.min(500, filters.limit ?? 100));

  return db.prepare(`
    SELECT event_uid, cluster_id, namespace, involved_kind, involved_name,
           reason, message, type, count, first_seen_at, last_seen_at
    FROM k8s_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `).all(...params) as K8sEventRow[];
}

interface NodeConditionRow {
  host_id: string;
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string | null;
  message: string | null;
  last_heartbeat_at: string | null;
  last_transition_at: string | null;
  observed_at: string;
}

/**
 * Current k8s node conditions for a single host. Rows are already
 * "latest per (host, type)" by virtue of the UPSERT primary key —
 * no window functions needed.
 *
 * `Ready` is pinned first because it's the most important condition
 * operationally; remaining conditions sort alphabetically.
 */
function getNodeConditionsForHost(db: Database.Database, hostId: string): NodeConditionRow[] {
  return db.prepare(`
    SELECT host_id, type, status, reason, message,
           last_heartbeat_at, last_transition_at, observed_at
    FROM node_conditions
    WHERE host_id = ?
    ORDER BY
      CASE type WHEN 'Ready' THEN 0 ELSE 1 END,
      type
  `).all(hostId) as NodeConditionRow[];
}

// ── RCA neighbors (Explore drawer on container detail) ──────────────────────
//
// `rca_edges` is rebuilt every scheduler cycle by hub/src/insights/rca/graph.ts
// and stores edges symmetrically with `from < to` (lex-sorted). Three edge
// types: same_host (0.3), same_compose (0.6), metric_corr (≥0.4 dynamic).
// A pair of containers can have multiple edge types — we collapse to one
// row per neighbor with the strongest weight as the score.

export interface RcaNeighbor {
  entity: string;          // "host_id/container_name"
  hostId: string;
  containerName: string;
  score: number;
  edgeTypes: string[];     // sorted, unique
  healthStatus: string | null;
  hasActiveAlert: boolean;
  isRemoved: boolean;      // container disappeared from registry
}

interface RcaPeerRow {
  peer: string;
  score: number;
  edge_types_csv: string;
}

/**
 * Top-N RCA neighbors of a container, ranked by edge weight. Returns null
 * never — empty array when nothing is in the graph yet (newly-seen container).
 */
function getRcaNeighbors(
  db: Database.Database,
  hostId: string,
  containerName: string,
  limit: number = 10,
): RcaNeighbor[] {
  const entity = `${hostId}/${containerName}`;
  // Edges live in rca_edges with from < to (see graph.ts addEdge), so to
  // enumerate every neighbor we union both sides. Collapse multi-type pairs
  // by GROUP BY on the peer.
  const rows = db.prepare(`
    WITH peers AS (
      SELECT to_entity AS peer, edge_type, weight FROM rca_edges WHERE from_entity = ?
      UNION ALL
      SELECT from_entity AS peer, edge_type, weight FROM rca_edges WHERE to_entity = ?
    )
    SELECT
      peer,
      MAX(weight) AS score,
      GROUP_CONCAT(DISTINCT edge_type) AS edge_types_csv
    FROM peers
    GROUP BY peer
    ORDER BY score DESC
    LIMIT ?
  `).all(entity, entity, Math.max(1, Math.min(50, limit))) as RcaPeerRow[];

  if (rows.length === 0) return [];

  // Per-peer state lookups. Limit is small (≤50), so prepared-statement reuse
  // keeps this cheap. Skip insightd's own containers — `same_host` would tie
  // every container on every host to insightd-agent / insightd-hub, which is
  // noise (matches the detector's filter).
  const healthStmt = db.prepare(`
    SELECT health_status FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
    ORDER BY collected_at DESC LIMIT 1
  `);
  const alertStmt = db.prepare(`
    SELECT 1 FROM alert_state
    WHERE host_id = ? AND target = ? AND resolved_at IS NULL
    LIMIT 1
  `);
  const removedStmt = db.prepare(`
    SELECT removed_at FROM containers WHERE host_id = ? AND container_name = ?
  `);

  const out: RcaNeighbor[] = [];
  for (const r of rows) {
    // entity format is `${host_id}/${container_name}`. Host IDs don't contain
    // slashes; container names can (k8s "ns/stable/container"), so split on
    // the *first* slash only.
    const slash = r.peer.indexOf('/');
    if (slash < 1) continue;
    const peerHostId = r.peer.slice(0, slash);
    const peerName = r.peer.slice(slash + 1);
    if (peerName.startsWith('insightd-')) continue;

    const health = healthStmt.get(peerHostId, peerName) as { health_status: string | null } | undefined;
    const alert = alertStmt.get(peerHostId, peerName) as { 1: number } | undefined;
    const reg = removedStmt.get(peerHostId, peerName) as { removed_at: string | null } | undefined;

    out.push({
      entity: r.peer,
      hostId: peerHostId,
      containerName: peerName,
      score: r.score,
      edgeTypes: r.edge_types_csv.split(',').filter(Boolean).sort(),
      healthStatus: health?.health_status ?? null,
      hasActiveAlert: !!alert,
      // No registry row OR removed_at set → treat as removed
      isRemoved: !reg || reg.removed_at != null,
    });
  }
  return out;
}

// ── Namespace topology (cluster overview page) ──────────────────────────────
//
// Composes latest container_snapshots + ingresses + pvcs + hosts into a
// single shape suitable for a graph view. Nothing here is new data — it's a
// reshape of what the agent already publishes.

export interface TopologyContainer {
  container_name: string;
  container: string;            // last segment, for display
  status: string;
  health_status: string | null;
  has_active_alert: boolean;
}

export interface TopologyPod {
  pod_uid: string;
  host_id: string;
  containers: TopologyContainer[];
}

export interface TopologyVolumeMount {
  type: 'pvc' | 'configMap' | 'secret' | 'emptyDir' | 'hostPath' | 'projected' | 'other';
  /** Referenced object name (PVC name, ConfigMap name, Secret name, hostPath
   *  path) — null for ambient types like emptyDir/projected. */
  target_name: string | null;
  /** All volume_names from the pod spec that resolve to the same target.
   *  Useful in the side-panel detail view; the graph only renders one edge
   *  per (workload, target) pair. */
  volume_names: string[];
}

export interface TopologyWorkload {
  kind: string | null;
  name: string;
  total_pods: number;
  unhealthy_pods: number;
  pods_by_node: Record<string, number>;
  pods: TopologyPod[];
  /** Highest severity across alerts + findings on this workload's containers.
   *  null when nothing is wrong — drives the workload card tone. */
  severity: TopologySeverity;
  active_alerts: TopologyAlert[];
  findings: TopologyFinding[];
  /** Volume references aggregated from pod.spec.volumes. Includes ambient
   *  types (emptyDir / projected) for completeness; the UI only draws
   *  edges to PVC nodes. */
  volume_mounts: TopologyVolumeMount[];
}

export interface TopologyIngress {
  id: number;
  name: string;
  hosts: string[];
  /** Service names extracted from paths[].serviceName — UI joins these to
   *  topology services by exact name to draw real Ingress→Service edges. */
  service_targets: string[];
}

export interface TopologyServicePort {
  name: string | null;
  port: number;
  target_port: number | string | null;
  protocol: string | null;
  node_port: number | null;
}

export interface TopologyService {
  name: string;
  type: string;            // ClusterIP / NodePort / LoadBalancer / ExternalName
  cluster_ip: string | null;
  external_name: string | null;
  ports: TopologyServicePort[];
  /** Workload keys this service routes to (selector ⊆ pod labels). May be
   *  empty for ExternalName services, headless services without backends,
   *  or misconfigured selectors that match no pod. */
  workload_keys: string[];
  /** True when the service has no selector OR an empty selector — these
   *  are leaf nodes in the graph (no pod backends). */
  is_external: boolean;
}

export interface TopologyPvc {
  name: string;
  phase: string;
  capacity_bytes: number | null;
  storage_class: string | null;
}

export interface TopologyNode {
  host_id: string;
  online: boolean;
  pod_count: number;
}

export type TopologySeverity = 'critical' | 'error' | 'warning' | null;

export interface TopologyAlert {
  /** alert_type — e.g. container_unhealthy, restart_loop, pod_pending. */
  type: string;
  /** target — container_name within this workload (or pod target for k8s). */
  container_name: string;
  level: 'critical' | 'error' | 'warning' | 'info';
  message: string | null;
  triggered_at: string;
}

export interface TopologyFinding {
  /** insights.entity_id — same as container_name. */
  container_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  suggested_action: string | null;
  confidence: string | null;
}

export interface TopologyRcaEdge {
  /** Workload key (`wl:${kind ?? '_'}:${name}`); always lex-ordered from < to so the UI can dedupe. */
  from: string;
  to: string;
  weight: number;
}

export interface NamespaceTopology {
  cluster_id: string;
  namespace: string;
  workloads: TopologyWorkload[];
  services: TopologyService[];
  ingresses: TopologyIngress[];
  pvcs: TopologyPvc[];
  nodes: TopologyNode[];
  /** Cross-workload metric correlation edges within this namespace. UI
   *  draws these dashed only when a workload with issues is selected.
   *  Live-only — empty array when time-traveled (rca_edges has no history). */
  rca_edges: TopologyRcaEdge[];
  /** ISO timestamp the response represents — null when live. Frontend
   *  uses this to show a "viewing snapshot from X" banner and to disable
   *  live-only surfaces (RCA neighbor overlay, diagnosis findings). */
  at: string | null;
}

interface ContainerLatestRow {
  host_id: string;
  container_name: string;
  container_id: string;
  workload_kind: string | null;
  status: string;
  health_status: string | null;
  host_online: number;
  /** JSON-stringified Record<string,string> from container_snapshots.labels.
   *  We need it for selector→workload matching now that v43 ingests
   *  Services. */
  labels: string | null;
}

function getNamespaceTopology(db: Database.Database, clusterId: string, namespace: string, offlineThresholdMinutes: number, at: string | null = null): NamespaceTopology {
  // When `at` is set we query historical snapshots — pick the latest row
  // whose timestamp is at or before `at`. Several surfaces are live-only
  // (rca_edges is rebuilt each cycle, insights is rebuilt each cycle, pod
  // volumes are pruned not soft-deleted) and degrade gracefully.
  const isTimeTraveled = at != null && at !== '';
  // Latest snapshot per container in this cluster + namespace.
  // Cluster id is matched via the same logic as getClusterIdForHost
  // (host_group_override > host_group > "cluster-{hostId}").
  // Time-travel filter: when `at` is set, pick the latest snapshot whose
  // collected_at is at-or-before `at`, AND restrict to containers that were
  // still active at that moment (registry's removed_at NULL or > at). Live
  // mode is unchanged — registry-active only.
  const containerRows = db.prepare(`
    WITH latest AS (
      SELECT cs.host_id, cs.container_name, cs.container_id,
             cs.workload_kind, cs.status, cs.health_status, cs.labels,
             CASE WHEN datetime(h.last_seen, '+' || ? || ' minutes') > datetime('now')
               THEN 1 ELSE 0 END AS host_online,
             ROW_NUMBER() OVER (
               PARTITION BY cs.host_id, cs.container_name
               ORDER BY cs.collected_at DESC
             ) AS rn
      FROM container_snapshots cs
      INNER JOIN hosts h ON h.host_id = cs.host_id
      INNER JOIN containers cr ON cr.host_id = cs.host_id AND cr.container_name = cs.container_name
      WHERE
        ${isTimeTraveled
          ? '(cr.removed_at IS NULL OR datetime(cr.removed_at) > datetime(?))'
          : 'cr.removed_at IS NULL'}
        AND h.runtime_type = 'kubernetes'
        AND COALESCE(h.host_group_override, h.host_group, 'cluster-' || h.host_id) = ?
        AND cs.container_name LIKE ?
        ${isTimeTraveled ? "AND datetime(cs.collected_at) <= datetime(?)" : ''}
    )
    SELECT host_id, container_name, container_id, workload_kind, status, health_status, host_online, labels
    FROM latest
    WHERE rn = 1
  `).all(
    ...(isTimeTraveled
      ? [offlineThresholdMinutes, at, clusterId, `${namespace}/%`, at]
      : [offlineThresholdMinutes, clusterId, `${namespace}/%`]),
  ) as ContainerLatestRow[];

  // Active alerts on these containers (one query, in-memory map).
  const alertNames = new Set<string>();
  if (containerRows.length > 0) {
    const placeholders = containerRows.map(() => '?').join(',');
    const alertRows = db.prepare(`
      SELECT host_id, target FROM alert_state
      WHERE resolved_at IS NULL AND target IN (${placeholders})
    `).all(...containerRows.map(r => r.container_name)) as Array<{ host_id: string; target: string }>;
    for (const a of alertRows) alertNames.add(`${a.host_id}${a.target}`);
  }

  // Group: workload (kind+stableName) → pod (podUid) → containers.
  // container_name = "namespace/stable/container[/...]"
  // container_id   = "podUid/stable/container"
  const workloadMap = new Map<string, TopologyWorkload>();
  // Parallel map of per-workload pod label sets, used downstream to match
  // Service selectors against pods (selector ⊆ pod_labels). Keyed by podUid
  // so sidecars don't double-count.
  const workloadLabels = new Map<string, Map<string, Record<string, string>>>();
  const nodeIdSet = new Set<string>();
  for (const r of containerRows) {
    const firstSlash = r.container_name.indexOf('/');
    if (firstSlash <= 0) continue;
    const rest = r.container_name.slice(firstSlash + 1);
    const secondSlash = rest.indexOf('/');
    const stable = secondSlash > 0 ? rest.slice(0, secondSlash) : rest;
    const containerSegment = secondSlash > 0 ? rest.slice(secondSlash + 1) : '';
    const podUid = r.container_id.split('/')[0] ?? r.host_id;
    // Format matches the frontend workloadKeyOf so service.workload_keys line up with React Flow node ids.
    const workloadKey = `wl:${r.workload_kind ?? "_"}:${stable}`;

    let wl = workloadMap.get(workloadKey);
    if (!wl) {
      wl = {
        kind: r.workload_kind ?? null,
        name: stable,
        total_pods: 0,
        unhealthy_pods: 0,
        pods_by_node: {},
        pods: [],
        severity: null,
        active_alerts: [],
        findings: [],
        volume_mounts: [],
      };
      workloadMap.set(workloadKey, wl);
      workloadLabels.set(workloadKey, new Map());
    }

    let pod = wl.pods.find(p => p.pod_uid === podUid);
    if (!pod) {
      pod = { pod_uid: podUid, host_id: r.host_id, containers: [] };
      wl.pods.push(pod);
      wl.total_pods += 1;
      wl.pods_by_node[r.host_id] = (wl.pods_by_node[r.host_id] ?? 0) + 1;
      // First container we've seen for this pod — capture its labels for
      // selector matching. All containers in a pod share pod-level labels.
      const labels = parseLabelsJson(r.labels);
      if (labels) workloadLabels.get(workloadKey)!.set(podUid, labels);
    }
    pod.containers.push({
      container_name: r.container_name,
      container: containerSegment,
      status: r.status,
      health_status: r.health_status,
      has_active_alert: alertNames.has(`${r.host_id}${r.container_name}`),
    });
    nodeIdSet.add(r.host_id);
  }

  // A pod is unhealthy if any of its containers is unhealthy.
  for (const wl of workloadMap.values()) {
    for (const pod of wl.pods) {
      if (pod.containers.some(c => c.health_status === 'unhealthy' || c.has_active_alert)) {
        wl.unhealthy_pods += 1;
      }
    }
  }

  // ── Diagnosis overlay: attribute alerts + findings to workloads ──────────
  //
  // Build a container_name → workloadKey map so alert/finding rows can be
  // attributed to the workload they belong to. The container_name is the
  // alert_state.target and the insights.entity_id, so a single map serves
  // both joins.
  const containerToWorkload = new Map<string, string>();
  for (const [wlKey, wl] of workloadMap) {
    for (const pod of wl.pods) {
      for (const c of pod.containers) {
        containerToWorkload.set(c.container_name, wlKey);
      }
    }
  }

  if (containerRows.length > 0) {
    const placeholders = containerRows.map(() => '?').join(',');
    const targets = containerRows.map(r => r.container_name);

    // Active alerts on workloads in this namespace. In time-traveled mode,
    // an alert is "active at T" when triggered_at <= T AND (resolved_at IS
    // NULL OR resolved_at > T) — so we see the alerts that were firing then.
    const activeAlerts = db.prepare(`
      SELECT host_id, alert_type, target, message, triggered_at
      FROM alert_state
      WHERE target IN (${placeholders})
        ${isTimeTraveled
          ? 'AND datetime(triggered_at) <= datetime(?) AND (resolved_at IS NULL OR datetime(resolved_at) > datetime(?))'
          : 'AND resolved_at IS NULL'}
      ORDER BY triggered_at DESC
    `).all(...targets, ...(isTimeTraveled ? [at, at] : [])) as Array<{
      host_id: string; alert_type: string; target: string;
      message: string | null; triggered_at: string;
    }>;

    for (const a of activeAlerts) {
      const wlKey = containerToWorkload.get(a.target);
      if (!wlKey) continue;
      const wl = workloadMap.get(wlKey);
      if (!wl) continue;
      const level = LEVEL_BY_ALERT_TYPE[a.alert_type] ?? 'info';
      wl.active_alerts.push({
        type: a.alert_type,
        container_name: a.target,
        level,
        message: a.message,
        triggered_at: a.triggered_at,
      });
      wl.severity = mergeSeverity(wl.severity, level);
    }

    // Workload-scoped alerts (workload_unavailable / _degraded / _rollout_stuck)
    // don't target container_name — they target "Kind/namespace/name". Pull
    // them by host_id=cluster_id and target prefix and merge into the same
    // workload severity + alert lists. Same time-travel semantics as above.
    const workloadAlerts = db.prepare(`
      SELECT host_id, alert_type, target, message, triggered_at
      FROM alert_state
      WHERE host_id = ?
        AND alert_type IN ('workload_unavailable','workload_degraded','workload_rollout_stuck')
        AND target LIKE ?
        ${isTimeTraveled
          ? 'AND datetime(triggered_at) <= datetime(?) AND (resolved_at IS NULL OR datetime(resolved_at) > datetime(?))'
          : 'AND resolved_at IS NULL'}
      ORDER BY triggered_at DESC
    `).all(
      clusterId,
      `%/${namespace}/%`,
      ...(isTimeTraveled ? [at, at] : []),
    ) as Array<{
      host_id: string; alert_type: string; target: string;
      message: string | null; triggered_at: string;
    }>;

    for (const a of workloadAlerts) {
      // target = "Kind/namespace/name" — match second segment exactly to the
      // namespace we're rendering (LIKE filter is necessary but loose).
      const parts = a.target.split('/');
      if (parts.length !== 3 || parts[1] !== namespace) continue;
      const [kind, , name] = parts;
      const wlKey = `wl:${kind}:${name}`;
      const wl = workloadMap.get(wlKey);
      // Tolerate misses: a workload might be in workload_rollouts but have
      // zero pods captured in container_snapshots (still creating, just
      // deleted, etc.). Skip rather than fabricate an empty card.
      if (!wl) continue;
      const level = LEVEL_BY_ALERT_TYPE[a.alert_type] ?? 'info';
      wl.active_alerts.push({
        type: a.alert_type,
        container_name: a.target,
        level,
        message: a.message,
        triggered_at: a.triggered_at,
      });
      wl.severity = mergeSeverity(wl.severity, level);
    }

    // Diagnosis findings from the insights table. Container insights only —
    // host insights aren't workload-attributable. The insights table uses
    // entity_id = "host_id/container_name" (see detector.ts), so we match
    // against the full entity-id form rather than just container_name.
    //
    // The insights table is fully rebuilt every detector cycle (no history),
    // so it's live-only — skip when time-traveled. The UI surfaces this as a
    // banner caveat alongside the same caveat for rca_edges.
    const insightEntities = isTimeTraveled
      ? []
      : containerRows.map(r => `${r.host_id}/${r.container_name}`);
    const entityToContainer = new Map(
      containerRows.map(r => [`${r.host_id}/${r.container_name}`, r.container_name]),
    );
    const insightPlaceholders = insightEntities.map(() => '?').join(',');
    const insightRows = insightEntities.length === 0 ? [] : db.prepare(`
      SELECT entity_id, category, severity, title, message, suggested_action, confidence
      FROM insights
      WHERE entity_type = 'container' AND entity_id IN (${insightPlaceholders})
    `).all(...insightEntities) as Array<{
      entity_id: string; category: string; severity: string;
      title: string; message: string;
      suggested_action: string | null; confidence: string | null;
    }>;

    for (const f of insightRows) {
      const containerName = entityToContainer.get(f.entity_id);
      if (!containerName) continue;
      const wlKey = containerToWorkload.get(containerName);
      if (!wlKey) continue;
      const wl = workloadMap.get(wlKey);
      if (!wl) continue;
      wl.findings.push({
        container_name: containerName,
        category: f.category,
        severity: f.severity,
        title: f.title,
        message: f.message,
        suggested_action: f.suggested_action,
        confidence: f.confidence,
      });
      // insights.severity is 'critical' | 'warning' | 'info' (no 'error' tier).
      // Use the level mapping that matches the alert ladder so rendering
      // colors stay consistent.
      const insightLevel: 'critical' | 'warning' | 'info' =
        f.severity === 'critical' ? 'critical' :
        f.severity === 'warning'  ? 'warning' : 'info';
      wl.severity = mergeSeverity(wl.severity, insightLevel);
    }

    // Workload-scoped insights (entity_type='workload') — currently used by
    // the right-sizing detector. entity_id format: cluster_id/kind/ns/name.
    // Same live-only caveat as container insights (the table is rebuilt every
    // detector cycle, no history).
    if (!isTimeTraveled) {
      const workloadInsightRows = db.prepare(`
        SELECT entity_id, category, severity, title, message, suggested_action, confidence
        FROM insights
        WHERE entity_type = 'workload' AND entity_id LIKE ?
      `).all(`${clusterId}/%/${namespace}/%`) as Array<{
        entity_id: string; category: string; severity: string;
        title: string; message: string;
        suggested_action: string | null; confidence: string | null;
      }>;

      for (const f of workloadInsightRows) {
        // entity_id = "cluster_id/kind/namespace/name" — match second-to-last
        // segment exactly to namespace (LIKE filter is necessary but loose).
        const parts = f.entity_id.split('/');
        if (parts.length !== 4 || parts[0] !== clusterId || parts[2] !== namespace) continue;
        const [, kind, , name] = parts;
        const wlKey = `wl:${kind}:${name}`;
        const wl = workloadMap.get(wlKey);
        if (!wl) continue;
        wl.findings.push({
          // No specific container — workload-level recommendation applies to all replicas.
          container_name: '',
          category: f.category,
          severity: f.severity,
          title: f.title,
          message: f.message,
          suggested_action: f.suggested_action,
          confidence: f.confidence,
        });
        const insightLevel: 'critical' | 'warning' | 'info' =
          f.severity === 'critical' ? 'critical' :
          f.severity === 'warning'  ? 'warning' : 'info';
        wl.severity = mergeSeverity(wl.severity, insightLevel);
      }
    }
  }

  // ── RCA neighbor edges within this namespace ────────────────────────────
  //
  // metric_corr edges only — same_host / same_compose are too noisy for the
  // overlay (every container in the namespace would touch every other).
  // Aggregate per-container edges (entity_id = "host_id/container_name") to
  // per-workload (workload key) edges, taking the max weight on collision.
  // Both endpoints must be containers we already have in this namespace, so
  // we don't bleed into other namespaces.
  const containerEntities = new Set<string>(
    containerRows.map(r => `${r.host_id}/${r.container_name}`),
  );
  const rcaEdgesMap = new Map<string, TopologyRcaEdge>();
  // Live-only — rca_edges is replaced wholesale each scheduler cycle, so
  // there's no historical view. The UI shows a banner about this when
  // time-traveled.
  if (!isTimeTraveled && containerEntities.size > 0) {
    const ents = Array.from(containerEntities);
    const placeholders = ents.map(() => '?').join(',');
    const rcaRows = db.prepare(`
      SELECT from_entity, to_entity, weight FROM rca_edges
      WHERE edge_type = 'metric_corr'
        AND from_entity IN (${placeholders}) AND to_entity IN (${placeholders})
    `).all(...ents, ...ents) as Array<{ from_entity: string; to_entity: string; weight: number }>;

    const entityToWorkload = (entity: string): string | null => {
      const slash = entity.indexOf('/');
      if (slash < 0) return null;
      const containerName = entity.slice(slash + 1);
      return containerToWorkload.get(containerName) ?? null;
    };

    for (const r of rcaRows) {
      const fromKey = entityToWorkload(r.from_entity);
      const toKey = entityToWorkload(r.to_entity);
      if (!fromKey || !toKey || fromKey === toKey) continue;
      const a = fromKey < toKey ? fromKey : toKey;
      const b = fromKey < toKey ? toKey : fromKey;
      const k = `${a}\n${b}`;
      const existing = rcaEdgesMap.get(k);
      if (!existing || r.weight > existing.weight) {
        rcaEdgesMap.set(k, { from: a, to: b, weight: r.weight });
      }
    }
  }
  const rca_edges = Array.from(rcaEdgesMap.values())
    .sort((x, y) => y.weight - x.weight);

  // ── Volume mounts: per-workload pvc/configMap/secret/etc references ─────
  //
  // The pod_volumes table is keyed by pod_uid; we already know which podUid
  // → workload via the per-container scan above. Aggregate so each workload
  // exposes one entry per (volume_type, target_name) pair, with the set of
  // volume_names that map to it (a pod can mount the same PVC under multiple
  // names, but for the graph we only care about the destination).
  const podUidToWorkload = new Map<string, string>();
  for (const r of containerRows) {
    const podUid = r.container_id.split('/')[0];
    if (!podUid) continue;
    const wlKey = containerToWorkload.get(r.container_name);
    if (wlKey) podUidToWorkload.set(podUid, wlKey);
  }

  const volumeMountsByWorkload = new Map<string, Map<string, TopologyVolumeMount>>();
  if (podUidToWorkload.size > 0) {
    // pod_volumes is pruned (not soft-deleted) when a pod disappears, so the
    // historical view captures only volumes that were observed at-or-before
    // `at` AND were still present in a later prune cycle. Acceptable
    // approximation — most pods we care about historically still exist now,
    // or have a snapshot recent enough to survive the prune window.
    const volumeRows = db.prepare(`
      SELECT pod_uid, volume_name, volume_type, target_name
      FROM pod_volumes
      WHERE cluster_id = ? AND namespace = ?
        ${isTimeTraveled ? 'AND datetime(observed_at) <= datetime(?)' : ''}
    `).all(...(isTimeTraveled ? [clusterId, namespace, at] : [clusterId, namespace])) as Array<{
      pod_uid: string; volume_name: string; volume_type: string; target_name: string | null;
    }>;
    for (const v of volumeRows) {
      const wlKey = podUidToWorkload.get(v.pod_uid);
      if (!wlKey) continue;
      let perWorkload = volumeMountsByWorkload.get(wlKey);
      if (!perWorkload) {
        perWorkload = new Map();
        volumeMountsByWorkload.set(wlKey, perWorkload);
      }
      // Dedupe by (volume_type, target_name) so a workload that mounts the
      // same PVC across replicas only renders one edge / chip. Ambient types
      // (emptyDir, projected) without a target_name dedupe by volume_name.
      const dedupeKey = `${v.volume_type}|${v.target_name ?? `~${v.volume_name}`}`;
      let entry = perWorkload.get(dedupeKey);
      if (!entry) {
        entry = {
          type: v.volume_type as TopologyVolumeMount['type'],
          target_name: v.target_name,
          volume_names: [],
        };
        perWorkload.set(dedupeKey, entry);
      }
      if (!entry.volume_names.includes(v.volume_name)) {
        entry.volume_names.push(v.volume_name);
      }
    }
  }
  for (const [wlKey, perWorkload] of volumeMountsByWorkload) {
    const wl = workloadMap.get(wlKey);
    if (!wl) continue;
    wl.volume_mounts = Array.from(perWorkload.values()).sort((a, b) => {
      // Sort PVCs first (graph-relevant), then ConfigMap/Secret (chips), then ambient.
      const order = (t: string) => t === 'pvc' ? 0 : t === 'configMap' ? 1 : t === 'secret' ? 2 : 3;
      const da = order(a.type) - order(b.type);
      if (da !== 0) return da;
      return (a.target_name ?? '').localeCompare(b.target_name ?? '');
    });
  }

  // Ingresses currently in this namespace (or at `at` when time-traveled —
  // the registry's UPSERT + removed_at lets us answer "was the ingress
  // present at T?" as observed_at <= T AND (removed_at IS NULL OR removed_at > T)).
  const ingressRows = db.prepare(`
    SELECT id, name, hosts, paths
    FROM k8s_ingresses
    WHERE cluster_id = ? AND namespace = ?
      ${isTimeTraveled
        ? 'AND datetime(observed_at) <= datetime(?) AND (removed_at IS NULL OR datetime(removed_at) > datetime(?))'
        : 'AND removed_at IS NULL'}
    ORDER BY name
  `).all(...(isTimeTraveled ? [clusterId, namespace, at, at] : [clusterId, namespace])) as Array<{ id: number; name: string; hosts: string; paths: string }>;
  const ingresses: TopologyIngress[] = ingressRows.map(row => {
    let hosts: string[] = [];
    let serviceTargets: string[] = [];
    try { hosts = JSON.parse(row.hosts) as string[]; } catch { /* ignore */ }
    try {
      const paths = JSON.parse(row.paths) as Array<{ serviceName?: string | null }>;
      const seen = new Set<string>();
      for (const p of paths) {
        if (p.serviceName && !seen.has(p.serviceName)) {
          seen.add(p.serviceName);
          serviceTargets.push(p.serviceName);
        }
      }
    } catch { /* ignore */ }
    return { id: row.id, name: row.name, hosts, service_targets: serviceTargets };
  });

  // PVCs latest per (cluster_id, namespace, pvc_name). When time-traveled,
  // pick the latest snapshot whose collected_at is at-or-before `at`.
  const pvcRows = db.prepare(`
    SELECT pvc_name AS name, phase, capacity_bytes, storage_class
    FROM pvc_snapshots
    WHERE cluster_id = ? AND namespace = ?
      AND collected_at = (
        SELECT MAX(collected_at) FROM pvc_snapshots p2
         WHERE p2.cluster_id = pvc_snapshots.cluster_id
           AND p2.namespace  = pvc_snapshots.namespace
           AND p2.pvc_name   = pvc_snapshots.pvc_name
           ${isTimeTraveled ? 'AND datetime(p2.collected_at) <= datetime(?)' : ''}
      )
    ORDER BY name
  `).all(...(isTimeTraveled ? [clusterId, namespace, at] : [clusterId, namespace])) as Array<{ name: string; phase: string; capacity_bytes: number | null; storage_class: string | null }>;
  const pvcs: TopologyPvc[] = pvcRows;

  // Nodes that host pods in this namespace.
  const nodes: TopologyNode[] = [];
  for (const hostId of Array.from(nodeIdSet).sort()) {
    let podCount = 0;
    let online = false;
    for (const r of containerRows) {
      if (r.host_id !== hostId) continue;
      online = !!r.host_online;  // any row will give us the host's online state
    }
    for (const wl of workloadMap.values()) {
      podCount += wl.pods_by_node[hostId] ?? 0;
    }
    nodes.push({ host_id: hostId, online, pod_count: podCount });
  }

  // Stable order: workloads alphabetically by name.
  const workloads = Array.from(workloadMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Services in this namespace + selector→workload matching. UPSERT
  // registry, so time-travel uses observed_at + removed_at like ingresses.
  const serviceRows = db.prepare(`
    SELECT name, type, cluster_ip, external_name, selector, ports
    FROM k8s_services
    WHERE cluster_id = ? AND namespace = ?
      ${isTimeTraveled
        ? 'AND datetime(observed_at) <= datetime(?) AND (removed_at IS NULL OR datetime(removed_at) > datetime(?))'
        : 'AND removed_at IS NULL'}
    ORDER BY name
  `).all(...(isTimeTraveled ? [clusterId, namespace, at, at] : [clusterId, namespace])) as Array<{
    name: string;
    type: string;
    cluster_ip: string | null;
    external_name: string | null;
    selector: string | null;
    ports: string;
  }>;

  const services: TopologyService[] = serviceRows.map(row => {
    let ports: TopologyServicePort[] = [];
    try {
      const raw = JSON.parse(row.ports) as Array<{
        name?: string | null; port: number; targetPort?: number | string | null;
        protocol?: string | null; nodePort?: number | null;
      }>;
      ports = raw.map(p => ({
        name: p.name ?? null,
        port: p.port,
        target_port: p.targetPort ?? null,
        protocol: p.protocol ?? null,
        node_port: p.nodePort ?? null,
      }));
    } catch { /* ignore malformed */ }

    let selector: Record<string, string> | null = null;
    try { selector = row.selector ? JSON.parse(row.selector) : null; } catch { /* ignore */ }

    // Match selector against pod labels of every workload. A workload matches
    // if any of its pods has a label set whose entries are a superset of the
    // selector. Empty/null selector means "no pod backends" — common for
    // ExternalName services, headless services with manual Endpoints, or
    // misconfigured services.
    const workloadKeys: string[] = [];
    if (selector && Object.keys(selector).length > 0) {
      for (const [wlKey, podLabels] of workloadLabels) {
        for (const labels of podLabels.values()) {
          if (selectorMatches(selector, labels)) {
            workloadKeys.push(wlKey);
            break;
          }
        }
      }
    }

    return {
      name: row.name,
      type: row.type,
      cluster_ip: row.cluster_ip,
      external_name: row.external_name,
      ports,
      workload_keys: workloadKeys.sort(),
      is_external: !selector || Object.keys(selector).length === 0,
    };
  });

  return {
    cluster_id: clusterId,
    namespace,
    workloads,
    services,
    ingresses,
    pvcs,
    nodes,
    rca_edges,
    at: isTimeTraveled ? at : null,
  };
}

/** Pick the higher of two severities for the diagnosis overlay. critical > error > warning > info > null. */
function mergeSeverity(current: TopologySeverity, incoming: 'critical' | 'error' | 'warning' | 'info'): TopologySeverity {
  const order: Record<string, number> = { info: 0, warning: 1, error: 2, critical: 3 };
  const cur = current ? order[current] : -1;
  const inc = order[incoming];
  if (inc > cur) {
    // info doesn't bubble up to a workload-level severity badge.
    if (incoming === 'info') return current;
    return incoming;
  }
  return current;
}

/** Parse a labels JSON column. Returns null on bad input — caller treats as no labels. */
function parseLabelsJson(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** True when every key/value in `selector` is present in `labels`. */
function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

// ── Cluster overview (landing page for a k8s cluster) ───────────────────────
//
// Aggregates the cluster's nodes, namespaces (with workload/pod/issue
// counts), and totals into a single response. All from existing data —
// no new schema or agent collection.

export interface ClusterNode {
  host_id: string;
  online: boolean;
  /** Total pods on this node (across all namespaces in this cluster). */
  pod_count: number;
}

export interface ClusterNamespaceSummary {
  namespace: string;
  workload_count: number;
  pod_count: number;
  unhealthy_pod_count: number;
  ingress_count: number;
  pvc_count: number;
  pvc_pending_count: number;
  active_alert_count: number;
}

export interface ClusterOverview {
  cluster_id: string;
  nodes: ClusterNode[];
  namespaces: ClusterNamespaceSummary[];
  totals: {
    nodes_online: number;
    nodes_offline: number;
    namespaces: number;
    workloads: number;
    pods: number;
    healthy_pods: number;
    unhealthy_pods: number;
    ingresses: number;
    pvcs: number;
    pvcs_pending: number;
    active_alerts: number;
  };
}

interface ClusterContainerRow {
  host_id: string;
  container_name: string;
  container_id: string;
  workload_kind: string | null;
  health_status: string | null;
  host_online: number;
}

function getClusterOverview(db: Database.Database, clusterId: string, offlineThresholdMinutes: number): ClusterOverview {
  // 1. All k8s containers in the cluster, latest per (host, name).
  const containerRows = db.prepare(`
    WITH latest AS (
      SELECT cs.host_id, cs.container_name, cs.container_id,
             cs.workload_kind, cs.health_status,
             CASE WHEN datetime(h.last_seen, '+' || ? || ' minutes') > datetime('now')
               THEN 1 ELSE 0 END AS host_online,
             ROW_NUMBER() OVER (
               PARTITION BY cs.host_id, cs.container_name
               ORDER BY cs.collected_at DESC
             ) AS rn
      FROM container_snapshots cs
      INNER JOIN hosts h ON h.host_id = cs.host_id
      INNER JOIN containers cr ON cr.host_id = cs.host_id AND cr.container_name = cs.container_name
      WHERE cr.removed_at IS NULL
        AND h.runtime_type = 'kubernetes'
        AND COALESCE(h.host_group_override, h.host_group, 'cluster-' || h.host_id) = ?
    )
    SELECT host_id, container_name, container_id, workload_kind, health_status, host_online
    FROM latest WHERE rn = 1
  `).all(offlineThresholdMinutes, clusterId) as ClusterContainerRow[];

  // 2. Active alerts on these containers.
  const alertNames = new Set<string>();
  if (containerRows.length > 0) {
    const placeholders = containerRows.map(() => '?').join(',');
    const alertRows = db.prepare(`
      SELECT host_id, target FROM alert_state
      WHERE resolved_at IS NULL AND target IN (${placeholders})
    `).all(...containerRows.map(r => r.container_name)) as Array<{ host_id: string; target: string }>;
    for (const a of alertRows) alertNames.add(`${a.host_id}${a.target}`);
  }

  // Group containers per (namespace, workload, podUid) so pod counts are
  // accurate (sidecars share a podUid).
  type NsAgg = {
    workloadKeys: Set<string>;
    podKeys: Set<string>;
    unhealthyPodKeys: Set<string>;
  };
  const nsMap = new Map<string, NsAgg>();
  const nodePods = new Map<string, number>();
  const nodeOnline = new Map<string, boolean>();

  for (const r of containerRows) {
    const firstSlash = r.container_name.indexOf('/');
    if (firstSlash <= 0) continue;
    const namespace = r.container_name.slice(0, firstSlash);
    const rest = r.container_name.slice(firstSlash + 1);
    const secondSlash = rest.indexOf('/');
    const stable = secondSlash > 0 ? rest.slice(0, secondSlash) : rest;
    const podUid = r.container_id.split('/')[0] ?? r.host_id;

    let agg = nsMap.get(namespace);
    if (!agg) {
      agg = { workloadKeys: new Set(), podKeys: new Set(), unhealthyPodKeys: new Set() };
      nsMap.set(namespace, agg);
    }
    agg.workloadKeys.add(`${r.workload_kind ?? '_'}${stable}`);
    const podKey = `${r.host_id}/${podUid}`;
    if (!agg.podKeys.has(podKey)) {
      agg.podKeys.add(podKey);
      nodePods.set(r.host_id, (nodePods.get(r.host_id) ?? 0) + 1);
    }
    if (r.health_status === 'unhealthy' || alertNames.has(`${r.host_id}${r.container_name}`)) {
      agg.unhealthyPodKeys.add(podKey);
    }
    nodeOnline.set(r.host_id, !!r.host_online);
  }

  // 3. Ingresses + PVCs grouped by namespace.
  const ingressByNs = new Map<string, number>();
  const ingressRows = db.prepare(`
    SELECT namespace, COUNT(*) AS c
    FROM k8s_ingresses
    WHERE cluster_id = ? AND removed_at IS NULL
    GROUP BY namespace
  `).all(clusterId) as Array<{ namespace: string; c: number }>;
  for (const r of ingressRows) ingressByNs.set(r.namespace, r.c);

  const pvcByNs = new Map<string, { total: number; pending: number }>();
  const pvcRows = db.prepare(`
    SELECT pvc_snapshots.namespace AS namespace, pvc_snapshots.phase AS phase
    FROM pvc_snapshots
    INNER JOIN (
      SELECT cluster_id, namespace, pvc_name, MAX(collected_at) AS maxed
      FROM pvc_snapshots
      WHERE cluster_id = ?
      GROUP BY cluster_id, namespace, pvc_name
    ) latest ON pvc_snapshots.cluster_id = latest.cluster_id
            AND pvc_snapshots.namespace  = latest.namespace
            AND pvc_snapshots.pvc_name   = latest.pvc_name
            AND pvc_snapshots.collected_at = latest.maxed
  `).all(clusterId) as Array<{ namespace: string; phase: string }>;
  for (const r of pvcRows) {
    const cur = pvcByNs.get(r.namespace) ?? { total: 0, pending: 0 };
    cur.total += 1;
    if (r.phase === 'Pending') cur.pending += 1;
    pvcByNs.set(r.namespace, cur);
  }

  // 4. Per-namespace active alert counts. Active alerts are scoped by host
  // (= node), so count alerts whose host is in this cluster AND whose
  // target's namespace matches.
  const alertsByNs = new Map<string, number>();
  const alertRows2 = db.prepare(`
    SELECT a.target
    FROM alert_state a
    INNER JOIN hosts h ON h.host_id = a.host_id
    WHERE a.resolved_at IS NULL
      AND h.runtime_type = 'kubernetes'
      AND COALESCE(h.host_group_override, h.host_group, 'cluster-' || h.host_id) = ?
  `).all(clusterId) as Array<{ target: string }>;
  for (const r of alertRows2) {
    const slash = r.target.indexOf('/');
    if (slash <= 0) continue;
    const ns = r.target.slice(0, slash);
    alertsByNs.set(ns, (alertsByNs.get(ns) ?? 0) + 1);
  }

  // 5. Build namespace summaries — union of namespaces seen via containers,
  // ingresses, or PVCs (a namespace with only PVCs but no pods should still
  // show up so the operator can see the orphan PVC).
  const allNamespaces = new Set<string>([
    ...nsMap.keys(),
    ...ingressByNs.keys(),
    ...pvcByNs.keys(),
  ]);
  const namespaces: ClusterNamespaceSummary[] = Array.from(allNamespaces).sort().map(ns => {
    const agg = nsMap.get(ns);
    const pvc = pvcByNs.get(ns);
    return {
      namespace: ns,
      workload_count: agg?.workloadKeys.size ?? 0,
      pod_count: agg?.podKeys.size ?? 0,
      unhealthy_pod_count: agg?.unhealthyPodKeys.size ?? 0,
      ingress_count: ingressByNs.get(ns) ?? 0,
      pvc_count: pvc?.total ?? 0,
      pvc_pending_count: pvc?.pending ?? 0,
      active_alert_count: alertsByNs.get(ns) ?? 0,
    };
  });

  // 6. Nodes — every host in the cluster, online or not.
  const nodeRows = db.prepare(`
    SELECT host_id,
           CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
             THEN 1 ELSE 0 END AS host_online
    FROM hosts
    WHERE runtime_type = 'kubernetes'
      AND COALESCE(host_group_override, host_group, 'cluster-' || host_id) = ?
    ORDER BY host_id
  `).all(offlineThresholdMinutes, clusterId) as Array<{ host_id: string; host_online: number }>;
  const nodes: ClusterNode[] = nodeRows.map(r => ({
    host_id: r.host_id,
    online: !!r.host_online,
    pod_count: nodePods.get(r.host_id) ?? 0,
  }));

  // 7. Totals.
  let totalPods = 0;
  let totalUnhealthy = 0;
  let totalWorkloads = 0;
  let totalIngresses = 0;
  let totalPvcs = 0;
  let totalPending = 0;
  let totalAlerts = 0;
  for (const ns of namespaces) {
    totalPods += ns.pod_count;
    totalUnhealthy += ns.unhealthy_pod_count;
    totalWorkloads += ns.workload_count;
    totalIngresses += ns.ingress_count;
    totalPvcs += ns.pvc_count;
    totalPending += ns.pvc_pending_count;
    totalAlerts += ns.active_alert_count;
  }

  return {
    cluster_id: clusterId,
    nodes,
    namespaces,
    totals: {
      nodes_online: nodes.filter(n => n.online).length,
      nodes_offline: nodes.filter(n => !n.online).length,
      namespaces: namespaces.length,
      workloads: totalWorkloads,
      pods: totalPods,
      healthy_pods: totalPods - totalUnhealthy,
      unhealthy_pods: totalUnhealthy,
      ingresses: totalIngresses,
      pvcs: totalPvcs,
      pvcs_pending: totalPending,
      active_alerts: totalAlerts,
    },
  };
}

/**
 * Image-wide Drain template catalog for a container, overlaid with this
 * specific container's recent spike summary (last hour). Templates that
 * fired abnormally on this container come first, sorted by max intensity;
 * everything else is ordered by lifetime occurrence count. The spike
 * fields are nullable — calm templates have all four set to null.
 *
 * Drives the unified <LogPatternsList /> in the container-detail Explore
 * drawer (replaces the previous separate "patterns" + "bursts" cards).
 */
function getLogPatternsForContainer(
  db: Database.Database,
  hostId: string,
  containerName: string,
  imageKey: string,
  limit: number = 20,
): Array<{
  template_hash: string;
  template: string;
  occurrence_count: number;
  semantic_tag: string | null;
  first_seen: string;
  last_seen: string;
  spike_count: number | null;
  max_intensity: number | null;
  latest_spike_ts: string | null;
  latest_batch_count: number | null;
}> {
  return db.prepare(`
    SELECT lt.template_hash, lt.template, lt.occurrence_count,
           lt.semantic_tag, lt.first_seen, lt.last_seen,
           spk.spike_count, spk.max_intensity, spk.latest_spike_ts,
           spk.latest_batch_count
    FROM log_templates lt
    LEFT JOIN (
      SELECT template_id,
             COUNT(*) AS spike_count,
             MAX(intensity) AS max_intensity,
             MAX(ts) AS latest_spike_ts,
             (
               SELECT batch_count FROM template_burst_events b2
               WHERE b2.template_id = b.template_id
                 AND b2.host_id = ? AND b2.container_name = ?
                 AND b2.ts >= datetime('now', '-1 hour')
               ORDER BY b2.ts DESC LIMIT 1
             ) AS latest_batch_count
      FROM template_burst_events b
      WHERE host_id = ? AND container_name = ?
        AND ts >= datetime('now', '-1 hour')
      GROUP BY template_id
    ) spk ON spk.template_id = lt.id
    WHERE lt.image = ?
    ORDER BY (spk.max_intensity IS NULL),
             spk.max_intensity DESC,
             lt.occurrence_count DESC
    LIMIT ?
  `).all(hostId, containerName, hostId, containerName, imageKey, limit) as any[];
}

/**
 * Per-container Drain template burst events within a window centered on
 * `centerIso`. Joins `template_burst_events` to `log_templates` so callers get
 * the template text + semantic tag without a second round-trip. Newest first.
 *
 * @param windowMs — total window size around `centerIso`, half on either side
 */
function getLogBursts(
  db: Database.Database,
  hostId: string,
  containerName: string,
  centerIso: string,
  windowMs: number,
  limit: number = 50,
): Array<{
  id: number;
  template_id: number;
  template: string;
  template_hash: string;
  semantic_tag: string | null;
  ts: string;
  batch_count: number;
  baseline_rate: number;
  intensity: number;
}> {
  const halfMs = Math.max(60_000, Math.floor(windowMs / 2));
  const center = new Date(centerIso);
  if (Number.isNaN(center.getTime())) return [];
  const fromIso = new Date(center.getTime() - halfMs).toISOString().slice(0, 19).replace('T', ' ');
  const toIso = new Date(center.getTime() + halfMs).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`
    SELECT b.id, b.template_id,
           lt.template AS template,
           lt.template_hash AS template_hash,
           b.semantic_tag,
           b.ts, b.batch_count, b.baseline_rate, b.intensity
    FROM template_burst_events b
    INNER JOIN log_templates lt ON lt.id = b.template_id
    WHERE b.host_id = ? AND b.container_name = ?
      AND b.ts >= ? AND b.ts <= ?
    ORDER BY b.ts DESC, b.intensity DESC
    LIMIT ?
  `).all(hostId, containerName, fromIso, toIso, limit) as any[];
}

module.exports = { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestContainer, getContainerImage, getLatestDisk, getLatestUpdates, getAlerts, getAlertsExplore, LEVEL_BY_ALERT_TYPE, getDashboard, getContainerHistory, getContainerAlerts, getLatestHostMetrics, getHostMetricsHistory, getContainerId, getHostRuntimeType, getUptimeTimeline, getResourceRankings, getTrends, getEvents, getDiskForecast, getDisksOverview, getVolumesOverview, getPvsOverview, getAllImageUpdates, getContainerDowntime, getK8sEventsForHost, getPodEvents, getNodeConditionsForHost, getClusterIdForHost, getRcaNeighbors, getNamespaceTopology, getClusterOverview, getLogBursts, getLogPatternsForContainer };
