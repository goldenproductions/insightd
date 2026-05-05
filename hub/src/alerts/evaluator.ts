import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');
const { sendAlert } = require('./sender');
const { isExcluded } = require('./filter');

interface AlertItem {
  type: string;
  hostId: string;
  target: string;
  message: string;
  value?: any;
  threshold?: any;
  triggeredAt?: string;
  isResolution?: boolean;
  reminderNumber?: number;
}

interface AlertsConfig {
  enabled: boolean;
  containerDown: boolean;
  restartCount: number;
  cpuPercent: number;
  memoryMb: number;
  diskPercent: number;
  hostCpuPercent: number;
  hostMemoryAvailableMb: number;
  hostLoadThreshold: number;
  hostOffline: boolean;
  hostOfflineMinutes: number;
  containerUnhealthy: boolean;
  excludeContainers: string;
  endpointDown: boolean | undefined;
  endpointFailureThreshold: number;
  containerMemoryLimitPercent: number;
  containerCpuLimitPercent: number;
  certExpiry?: boolean;
  certExpiryWarnDays?: number;
  podPending?: boolean;
  podPendingMinutes?: number;
  workloadUnavailable?: boolean;
  workloadUnavailableMinutes?: number;
  workloadDegraded?: boolean;
  workloadDegradedMinutes?: number;
  workloadRolloutStuck?: boolean;
  workloadRolloutStuckMinutes?: number;
  /** Days since last successful vzdump before pve_backup_overdue fires. 0 = disabled. */
  pveBackupAgeWarnDays?: number;
  cooldownMinutes: number;
  reminderBackoff?: boolean;
  reminderMaxMinutes?: number;
  to: string;
}

/**
 * Required minutes between reminders. With backoff enabled, the gap doubles
 * each reminder (base, 2×, 4×, 8×, …) and caps at reminderMaxMinutes — so a
 * persistent alert settles into at most one notification per cap window.
 * notifyCount is the cumulative count *before* the next reminder (so after
 * the initial send it's 1, meaning "wait base minutes for reminder #1").
 */
function requiredReminderGap(notifyCount: number, baseMinutes: number, capMinutes: number, backoff: boolean): number {
  if (!backoff) return baseMinutes;
  const exponent = Math.max(0, notifyCount - 1);
  const scaled = baseMinutes * Math.pow(2, Math.min(exponent, 30));
  return Math.min(scaled, capMinutes);
}

interface EvaluatorConfig {
  alerts: AlertsConfig;
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  };
}

interface EvaluationResult {
  triggered: AlertItem[];
  resolved: AlertItem[];
}

/**
 * Evaluate all alert conditions against the latest data.
 * Checks all hosts. Returns { triggered: [], resolved: [] }
 */
function evaluateAlerts(db: Database.Database, config: EvaluatorConfig): EvaluationResult {
  const alerts = config.alerts;
  const triggered: AlertItem[] = [];
  const resolved: AlertItem[] = [];

  const excludePatterns = alerts.excludeContainers || '';
  const notExcluded = (a: AlertItem): boolean => !isExcluded(a.target, excludePatterns);

  // Get all known hosts
  const hosts = db.prepare('SELECT DISTINCT host_id FROM container_snapshots').all() as { host_id: string }[];

  for (const { host_id } of hosts) {
    if (alerts.containerDown) {
      triggered.push(...checkContainerDown(db, host_id).filter(notExcluded));
    }
    if (alerts.restartCount > 0) {
      triggered.push(...checkRestartLoop(db, host_id, alerts.restartCount).filter(notExcluded));
    }
    if (alerts.cpuPercent > 0) {
      triggered.push(...checkHighCpu(db, host_id, alerts.cpuPercent).filter(notExcluded));
    }
    if (alerts.memoryMb > 0) {
      triggered.push(...checkHighMemory(db, host_id, alerts.memoryMb).filter(notExcluded));
    }
    if (alerts.containerMemoryLimitPercent > 0) {
      triggered.push(...checkMemoryLimitSaturation(db, host_id, alerts.containerMemoryLimitPercent).filter(notExcluded));
    }
    if (alerts.containerCpuLimitPercent > 0) {
      triggered.push(...checkCpuLimitSaturation(db, host_id, alerts.containerCpuLimitPercent).filter(notExcluded));
    }
  }

  // Host-level alerts (not filtered — these are host-wide, not per-container)
  const hostRows = db.prepare('SELECT DISTINCT host_id FROM host_snapshots').all() as { host_id: string }[];
  for (const { host_id } of hostRows) {
    if (alerts.hostCpuPercent > 0) {
      triggered.push(...checkHighHostCpu(db, host_id, alerts.hostCpuPercent));
    }
    if (alerts.hostMemoryAvailableMb > 0) {
      triggered.push(...checkLowHostMemory(db, host_id, alerts.hostMemoryAvailableMb));
    }
    if (alerts.hostLoadThreshold > 0) {
      triggered.push(...checkHighLoad(db, host_id, alerts.hostLoadThreshold));
    }
    // K8s node conditions — fires only on k8s hosts (non-k8s hosts never
    // have rows in node_conditions). No config toggle in v1.
    triggered.push(...checkNodePressure(db, host_id));
    triggered.push(...checkNodeNotReady(db, host_id));
  }

  // Host offline — iterate the `hosts` table directly so we don't rely on
  // host_snapshots rows (which can be pruned by retention). Threshold of 0
  // disables; the toggle is the explicit kill switch.
  if (alerts.hostOffline && alerts.hostOfflineMinutes > 0) {
    triggered.push(...checkHostOffline(db, alerts.hostOfflineMinutes));
  }

  // Container health
  for (const { host_id } of hosts) {
    if (alerts.containerUnhealthy) {
      triggered.push(...checkContainerUnhealthy(db, host_id).filter(notExcluded));
    }
  }

  // Disk — check across all hosts
  if (alerts.diskPercent > 0) {
    triggered.push(...checkDiskFull(db, alerts.diskPercent));
  }

  // HTTP endpoints — hub-level checks
  if (alerts.endpointDown !== false) {
    triggered.push(...checkEndpointDown(db, alerts.endpointFailureThreshold || 3));
  }

  // TLS certificate checks — three alert types: expired (critical), invalid
  // (error, e.g. chain/hostname), expiring_soon (warning). All keyed by
  // endpoint name so cooldown/resolution flow through alert_state.
  if (alerts.certExpiry !== false) {
    triggered.push(...checkCertAlerts(db, alerts.certExpiryWarnDays || 14));
  }

  // Pods stuck Pending past threshold — cluster-scoped (leader-published).
  if (alerts.podPending !== false) {
    triggered.push(...checkPodPending(db, alerts.podPendingMinutes ?? 5));
  }

  // Workload rollout health — cluster-scoped (leader-published). Three
  // distinct conditions, each with its own threshold and severity:
  //   - workload_unavailable    (ready=0,         critical, default 10min)
  //   - workload_degraded       (partial,         error,    default 10min)
  //   - workload_rollout_stuck  (updates pending, warning,  default 10min)
  if (alerts.workloadUnavailable !== false) {
    triggered.push(...checkWorkloadUnavailable(db, alerts.workloadUnavailableMinutes ?? 10));
  }
  if (alerts.workloadDegraded !== false) {
    triggered.push(...checkWorkloadDegraded(db, alerts.workloadDegradedMinutes ?? 10));
  }
  if (alerts.workloadRolloutStuck !== false) {
    triggered.push(...checkWorkloadRolloutStuck(db, alerts.workloadRolloutStuckMinutes ?? 10));
  }

  // Proxmox VE — only fires for hosts that publish PVE data; non-PVE
  // deployments have empty tables and emit nothing. No config toggle.
  triggered.push(...checkPveZfsUnhealthy(db));
  triggered.push(...checkPveClusterQuorumLost(db));
  if (alerts.diskPercent > 0) {
    triggered.push(...checkPveStorageSaturation(db, alerts.diskPercent));
  }
  triggered.push(...checkPveBackupOverdue(db, alerts.pveBackupAgeWarnDays ?? 7));

  // Check for resolutions of active alerts
  resolved.push(...checkResolutions(db, alerts));

  return { triggered, resolved };
}

function checkContainerDown(db: Database.Database, hostId: string): AlertItem[] {
  const alerts: AlertItem[] = [];
  const containers = db.prepare(
    'SELECT DISTINCT container_name FROM container_snapshots WHERE host_id = ?'
  ).all(hostId) as { container_name: string }[];

  for (const { container_name } of containers) {
    const rows = db.prepare(`
      SELECT status, exit_code, collected_at FROM container_snapshots
      WHERE host_id = ? AND container_name = ?
      ORDER BY collected_at DESC LIMIT 2
    `).all(hostId, container_name) as { status: string; exit_code: number | null; collected_at: string }[];

    if (rows.length < 2) continue;
    const [latest, previous] = rows;
    // Successfully-completed one-shots (exited with code 0) aren't failures,
    // so don't page someone about them even though the status transitioned.
    if (latest.status === 'exited' && latest.exit_code === 0) continue;
    if ((latest.status === 'exited' || latest.status === 'dead') && previous.status === 'running') {
      alerts.push({
        type: 'container_down',
        hostId,
        target: container_name,
        message: `Container "${container_name}" on ${hostId} is down (was running, now ${latest.status})`,
        value: latest.status,
      });
    }
  }
  return alerts;
}

function checkRestartLoop(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const alerts: AlertItem[] = [];
  const containers = db.prepare(
    'SELECT DISTINCT container_name FROM container_snapshots WHERE host_id = ?'
  ).all(hostId) as { container_name: string }[];

  for (const { container_name } of containers) {
    const latest = db.prepare(`
      SELECT restart_count, last_oom_killed_at FROM container_snapshots
      WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name) as { restart_count: number; last_oom_killed_at: string | null } | undefined;

    const older = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND collected_at <= datetime('now', '-30 minutes')
      ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name) as { restart_count: number } | undefined;

    if (!latest || !older) continue;
    const delta = latest.restart_count - older.restart_count;
    if (delta >= threshold) {
      const base = `Container "${container_name}" on ${hostId} restarted ${delta} times in 30 minutes (threshold: ${threshold})`;
      const oomSuffix = oomCauseSuffix(latest.last_oom_killed_at);
      alerts.push({
        type: 'restart_loop',
        hostId,
        target: container_name,
        message: oomSuffix ? `${base}${oomSuffix}` : base,
        value: delta,
        threshold,
      });
    }
  }
  return alerts;
}

/**
 * Format an "— last killed by OOM" suffix for restart_loop / container_unhealthy
 * alert messages, when the kernel-reported OOMKill was within the last 30
 * minutes. Returns "" when the signal is missing or stale, so callers can
 * unconditionally concat without a branch.
 */
function oomCauseSuffix(lastOomKilledAt: string | null | undefined): string {
  if (!lastOomKilledAt) return '';
  const ts = Date.parse(lastOomKilledAt);
  if (!Number.isFinite(ts)) return '';
  if (Date.now() - ts > 30 * 60 * 1000) return '';
  return ' — last killed by OOM (memory limit reached, consider raising it)';
}

function checkHighCpu(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, cpu_percent FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND cpu_percent IS NOT NULL AND status = 'running'
  `).all(hostId, hostId) as { container_name: string; cpu_percent: number }[];

  return rows
    .filter(r => r.cpu_percent > threshold)
    .map(r => ({
      type: 'high_cpu',
      hostId,
      target: r.container_name,
      message: `Container "${r.container_name}" on ${hostId} CPU at ${r.cpu_percent}% (threshold: ${threshold}%)`,
      value: r.cpu_percent,
      threshold,
    }));
}

function checkHighMemory(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, memory_mb FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND memory_mb IS NOT NULL AND status = 'running'
  `).all(hostId, hostId) as { container_name: string; memory_mb: number }[];

  return rows
    .filter(r => r.memory_mb > threshold)
    .map(r => ({
      type: 'high_memory',
      hostId,
      target: r.container_name,
      message: `Container "${r.container_name}" on ${hostId} using ${Math.round(r.memory_mb)}MB RAM (threshold: ${threshold}MB)`,
      value: r.memory_mb,
      threshold,
    }));
}

/**
 * Fire `container_memory_saturation` when a k8s container's memory usage
 * is over `threshold` percent of its pod spec memory limit — the point
 * where OOMKill becomes imminent. Only applies to containers with a limit
 * set (Docker or unlimited-k8s containers never fire).
 */
function checkMemoryLimitSaturation(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, memory_mb, memory_limit_mb,
           ROUND(memory_mb / memory_limit_mb * 100, 1) AS percent
    FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    )
      AND memory_limit_mb IS NOT NULL AND memory_limit_mb > 0
      AND memory_mb IS NOT NULL
      AND status = 'running'
  `).all(hostId, hostId) as { container_name: string; memory_mb: number; memory_limit_mb: number; percent: number }[];

  return rows
    .filter(r => r.percent > threshold)
    .map(r => ({
      type: 'container_memory_saturation',
      hostId,
      target: r.container_name,
      message: `Container "${r.container_name}" on ${hostId} at ${r.percent}% of memory limit (${Math.round(r.memory_mb)}MB / ${Math.round(r.memory_limit_mb)}MB, threshold: ${threshold}%)`,
      value: r.percent,
      threshold,
    }));
}

/**
 * Fire `container_cpu_saturation` when a k8s container's CPU usage is
 * over `threshold` percent of its pod spec CPU limit. cpu_limit_percent
 * is computed on the agent since cpu_percent is node-normalized.
 */
function checkCpuLimitSaturation(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, cpu_limit_percent, cpu_limit_cores
    FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    )
      AND cpu_limit_percent IS NOT NULL
      AND status = 'running'
  `).all(hostId, hostId) as { container_name: string; cpu_limit_percent: number; cpu_limit_cores: number | null }[];

  return rows
    .filter(r => r.cpu_limit_percent > threshold)
    .map(r => ({
      type: 'container_cpu_saturation',
      hostId,
      target: r.container_name,
      message: `Container "${r.container_name}" on ${hostId} at ${r.cpu_limit_percent}% of CPU limit${r.cpu_limit_cores ? ` (${r.cpu_limit_cores} cores)` : ''}, threshold: ${threshold}%`,
      value: r.cpu_limit_percent,
      threshold,
    }));
}

function checkDiskFull(db: Database.Database, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT host_id, mount_point, used_percent, used_gb, total_gb FROM disk_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM disk_snapshots)
  `).all() as { host_id: string; mount_point: string; used_percent: number; used_gb: number; total_gb: number }[];

  return rows
    .filter(r => r.used_percent > threshold)
    .map(r => ({
      type: 'disk_full',
      hostId: r.host_id,
      target: r.mount_point,
      message: `Disk "${r.mount_point}" on ${r.host_id} at ${r.used_percent}% (${r.used_gb}/${r.total_gb}GB, threshold: ${threshold}%)`,
      value: r.used_percent,
      threshold,
    }));
}

function checkHighHostCpu(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const latest = db.prepare(
    'SELECT cpu_percent FROM host_snapshots WHERE host_id = ? AND cpu_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1'
  ).get(hostId) as { cpu_percent: number } | undefined;
  if (!latest || latest.cpu_percent <= threshold) return [];
  return [{
    type: 'high_host_cpu', hostId, target: 'system',
    message: `Host "${hostId}" CPU at ${latest.cpu_percent}% (threshold: ${threshold}%)`,
    value: latest.cpu_percent,
    threshold,
  }];
}

function checkLowHostMemory(db: Database.Database, hostId: string, thresholdMb: number): AlertItem[] {
  const latest = db.prepare(
    'SELECT memory_available_mb FROM host_snapshots WHERE host_id = ? AND memory_available_mb IS NOT NULL ORDER BY collected_at DESC LIMIT 1'
  ).get(hostId) as { memory_available_mb: number } | undefined;
  if (!latest || latest.memory_available_mb >= thresholdMb) return [];
  return [{
    type: 'low_host_memory', hostId, target: 'system',
    message: `Host "${hostId}" available memory low: ${Math.round(latest.memory_available_mb)}MB (threshold: ${thresholdMb}MB)`,
    value: latest.memory_available_mb,
    threshold: thresholdMb,
  }];
}

function checkHighLoad(db: Database.Database, hostId: string, threshold: number): AlertItem[] {
  const latest = db.prepare(
    'SELECT load_5 FROM host_snapshots WHERE host_id = ? AND load_5 IS NOT NULL ORDER BY collected_at DESC LIMIT 1'
  ).get(hostId) as { load_5: number } | undefined;
  if (!latest || latest.load_5 <= threshold) return [];
  return [{
    type: 'high_load', hostId, target: 'system',
    message: `Host "${hostId}" load average: ${latest.load_5} (threshold: ${threshold})`,
    value: latest.load_5,
    threshold,
  }];
}

/**
 * Fire `node_pressure` for each k8s pressure condition currently set to
 * True. `target` is the condition type (MemoryPressure / DiskPressure /
 * PIDPressure) so each fires and resolves independently.
 */
function checkNodePressure(db: Database.Database, hostId: string): AlertItem[] {
  const rows = db.prepare(`
    SELECT type, reason, message
    FROM node_conditions
    WHERE host_id = ?
      AND type IN ('MemoryPressure', 'DiskPressure', 'PIDPressure')
      AND status = 'True'
  `).all(hostId) as Array<{ type: string; reason: string | null; message: string | null }>;
  return rows.map(r => ({
    type: 'node_pressure',
    hostId,
    target: r.type,
    message: `Node "${hostId}" has ${r.type}=True${r.reason ? ` (${r.reason})` : ''}: ${r.message ?? 'no detail'}`,
    value: r.type,
    threshold: null,
  }));
}

/**
 * Fire `node_not_ready` when the Ready condition is anything other than
 * True (False or Unknown). Ready=Unknown is the kubelet-lost-contact case.
 */
function checkNodeNotReady(db: Database.Database, hostId: string): AlertItem[] {
  const r = db.prepare(`
    SELECT status, reason, message FROM node_conditions
    WHERE host_id = ? AND type = 'Ready' AND status != 'True'
  `).get(hostId) as { status: string; reason: string | null; message: string | null } | undefined;
  if (!r) return [];
  return [{
    type: 'node_not_ready',
    hostId,
    target: 'Ready',
    message: `Node "${hostId}" is not Ready (status=${r.status}${r.reason ? `, ${r.reason}` : ''}): ${r.message ?? 'no detail'}`,
    value: r.status,
    threshold: 'True',
  }];
}

/**
 * Fire host_offline for any host whose agent hasn't reported in
 * `thresholdMinutes`. Queried directly from the `hosts` table (not
 * host_snapshots) so the check keeps working for hosts whose snapshot
 * rows have aged out of the retention window.
 */
function checkHostOffline(db: Database.Database, thresholdMinutes: number): AlertItem[] {
  const rows = db.prepare(
    "SELECT host_id, last_seen, " +
    " CAST((strftime('%s','now') - strftime('%s', last_seen)) / 60 AS INTEGER) AS offline_minutes " +
    "FROM hosts WHERE last_seen < datetime('now', ?)"
  ).all(`-${thresholdMinutes} minutes`) as Array<{ host_id: string; last_seen: string; offline_minutes: number }>;

  return rows.map(r => ({
    type: 'host_offline',
    hostId: r.host_id,
    target: 'system',
    message: `Host "${r.host_id}" has not reported in ${r.offline_minutes} minutes (last seen ${r.last_seen})`,
    value: r.offline_minutes,
    threshold: thresholdMinutes,
  }));
}

function checkContainerUnhealthy(db: Database.Database, hostId: string): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, health_status, health_check_output, last_oom_killed_at FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND health_status = 'unhealthy'
  `).all(hostId, hostId) as { container_name: string; health_status: string; health_check_output: string | null; last_oom_killed_at: string | null }[];

  return rows.map(r => {
    const base = `Container "${r.container_name}" on ${hostId} is unhealthy`;
    const output = r.health_check_output?.slice(0, 200);
    const oomSuffix = oomCauseSuffix(r.last_oom_killed_at);
    const message = output ? `${base} — ${output}${oomSuffix}` : `${base}${oomSuffix}`;
    return {
      type: 'container_unhealthy', hostId, target: r.container_name,
      message,
      value: 'unhealthy',
    };
  });
}

interface CertEndpointRow {
  id: number;
  name: string;
  url: string;
  enabled: number;
  tls_expires_at: string | null;
  tls_error: string | null;
  tls_last_checked_at: string | null;
}

const TLS_TRANSIENT_ERRORS = new Set(['timeout', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'tls-error']);

function checkCertAlerts(db: Database.Database, warnDays: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT id, name, url, enabled, tls_expires_at, tls_error, tls_last_checked_at
    FROM http_endpoints
    WHERE enabled = 1 AND url LIKE 'https://%' AND tls_last_checked_at IS NOT NULL
  `).all() as CertEndpointRow[];

  const out: AlertItem[] = [];
  const now = Date.now();
  for (const ep of rows) {
    const expiryMs = ep.tls_expires_at ? Date.parse(ep.tls_expires_at) : NaN;
    const hasExpiry = Number.isFinite(expiryMs);

    if (ep.tls_error === 'expired' || (hasExpiry && expiryMs < now)) {
      out.push({
        type: 'cert_expired',
        hostId: 'hub',
        target: ep.name,
        message: `Certificate for "${ep.name}" (${ep.url}) has expired`,
        value: ep.tls_expires_at,
      });
      continue;
    }
    if (ep.tls_error && !TLS_TRANSIENT_ERRORS.has(ep.tls_error) && ep.tls_error !== 'expired') {
      out.push({
        type: 'cert_invalid',
        hostId: 'hub',
        target: ep.name,
        message: `Certificate for "${ep.name}" (${ep.url}) is invalid: ${ep.tls_error}`,
        value: ep.tls_error,
      });
      continue;
    }
    if (hasExpiry && warnDays > 0) {
      const daysLeft = (expiryMs - now) / 86400000;
      if (daysLeft <= warnDays) {
        const rounded = Math.max(0, Math.ceil(daysLeft));
        out.push({
          type: 'cert_expiring_soon',
          hostId: 'hub',
          target: ep.name,
          message: `Certificate for "${ep.name}" (${ep.url}) expires in ${rounded} day${rounded === 1 ? '' : 's'}`,
          value: ep.tls_expires_at,
          threshold: warnDays,
        });
      }
    }
  }
  return out;
}

interface PendingPodRow {
  cluster_id: string;
  namespace: string;
  pod_name: string;
  reason: string | null;
  message: string | null;
  workload_kind: string | null;
  workload_name: string | null;
  age_minutes: number;
}

function checkPodPending(db: Database.Database, thresholdMinutes: number): AlertItem[] {
  const rows = db.prepare(
    "SELECT cluster_id, namespace, pod_name, reason, message, workload_kind, workload_name, " +
    " CAST((strftime('%s','now') - strftime('%s', first_seen_at)) / 60 AS INTEGER) AS age_minutes " +
    " FROM pending_pods " +
    "WHERE first_seen_at < datetime('now', ?)"
  ).all(`-${thresholdMinutes} minutes`) as PendingPodRow[];

  return rows.map(r => {
    // target uniquely identifies the pod within a cluster — alert_state
    // dedupes on (host_id, alert_type, target), so cluster_id goes into
    // host_id and ns/pod into target.
    const owner = r.workload_kind && r.workload_name
      ? ` (${r.workload_kind}/${r.workload_name})`
      : '';
    const reasonPart = r.reason ? r.reason : 'Pending';
    const detail = r.message ? ` — ${r.message.slice(0, 200)}` : '';
    return {
      type: 'pod_pending',
      hostId: r.cluster_id,
      target: `${r.namespace}/${r.pod_name}`,
      message: `Pod "${r.namespace}/${r.pod_name}"${owner} stuck ${reasonPart} for ${r.age_minutes}m${detail}`,
      value: r.reason ?? 'Pending',
      threshold: thresholdMinutes,
    };
  });
}

interface WorkloadRolloutRow {
  cluster_id: string;
  kind: string;
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  generation: number;
  observed_generation: number;
  progress_deadline_exceeded: number;
  age_minutes: number;
}

/**
 * Build a (cluster_id-scoped) target string for workload alerts. Format
 * mirrors `Kind/namespace/name`, matching the K8sIdentityStrip's display
 * format and giving the UI router a parseable key. The whole string also
 * keeps `target` unique across kinds — two different StatefulSets vs
 * Deployments with the same namespace+name can both fire independently.
 */
function workloadTarget(kind: string, namespace: string, name: string): string {
  return `${kind}/${namespace}/${name}`;
}

/**
 * Fire `workload_unavailable` (critical) when a workload has been at zero
 * Ready replicas with at least one desired replica for at least
 * `thresholdMinutes`. This is the workload-scoped equivalent of
 * `container_down` — every pod is dead, the service is offline.
 *
 * Threshold is gated by `first_seen_at` rather than tracking the time the
 * row entered the unavailable state. Practically the difference is small:
 * a fresh workload with ready=0 is either rolling out (will go ready
 * within a minute or two) or genuinely broken (will still be ready=0 ten
 * minutes later). False positives during initial rollout are absorbed by
 * the threshold itself.
 */
function checkWorkloadUnavailable(db: Database.Database, thresholdMinutes: number): AlertItem[] {
  const rows = db.prepare(
    "SELECT cluster_id, kind, namespace, name, desired, ready, updated, " +
    " generation, observed_generation, progress_deadline_exceeded, " +
    " CAST((strftime('%s','now') - strftime('%s', first_seen_at)) / 60 AS INTEGER) AS age_minutes " +
    " FROM workload_rollouts " +
    "WHERE ready = 0 AND desired > 0 AND first_seen_at < datetime('now', ?)"
  ).all(`-${thresholdMinutes} minutes`) as WorkloadRolloutRow[];

  return rows.map(r => ({
    type: 'workload_unavailable',
    hostId: r.cluster_id,
    target: workloadTarget(r.kind, r.namespace, r.name),
    message: `${r.kind} "${r.namespace}/${r.name}" is unavailable — 0/${r.desired} replicas Ready for ${r.age_minutes}m`,
    value: r.ready,
    threshold: r.desired,
  }));
}

/**
 * Fire `workload_degraded` (error) when a workload has been partially
 * unavailable (ready < desired but ready > 0) for at least
 * `thresholdMinutes`. Distinct from `workload_unavailable` so the user can
 * mute "degraded" while keeping the louder "unavailable" pages on.
 *
 * The two conditions are mutually exclusive on a row — when ready drops
 * to zero the row trips unavailable instead, and degraded resolves.
 */
function checkWorkloadDegraded(db: Database.Database, thresholdMinutes: number): AlertItem[] {
  const rows = db.prepare(
    "SELECT cluster_id, kind, namespace, name, desired, ready, updated, " +
    " generation, observed_generation, progress_deadline_exceeded, " +
    " CAST((strftime('%s','now') - strftime('%s', first_seen_at)) / 60 AS INTEGER) AS age_minutes " +
    " FROM workload_rollouts " +
    "WHERE ready > 0 AND ready < desired AND first_seen_at < datetime('now', ?)"
  ).all(`-${thresholdMinutes} minutes`) as WorkloadRolloutRow[];

  return rows.map(r => ({
    type: 'workload_degraded',
    hostId: r.cluster_id,
    target: workloadTarget(r.kind, r.namespace, r.name),
    message: `${r.kind} "${r.namespace}/${r.name}" is degraded — ${r.ready}/${r.desired} replicas Ready for ${r.age_minutes}m`,
    value: r.ready,
    threshold: r.desired,
  }));
}

/**
 * Fire `workload_rollout_stuck` (warning) when a rollout isn't progressing.
 * Two signals, OR'd:
 *   1. Deployment with Progressing=False, reason=ProgressDeadlineExceeded
 *      (the controller has explicitly given up). Fires immediately —
 *      ProgressDeadline is K8s-level and already much longer than our
 *      threshold (default 600s upstream).
 *   2. updated < desired sustained for `thresholdMinutes` — covers
 *      StatefulSets and DaemonSets that don't have ProgressDeadline,
 *      and also Deployments where the rollout is still wedged but
 *      hasn't yet hit the K8s deadline.
 *
 * We don't fire if ready=0 (that's already workload_unavailable, louder).
 */
function checkWorkloadRolloutStuck(db: Database.Database, thresholdMinutes: number): AlertItem[] {
  const rows = db.prepare(
    "SELECT cluster_id, kind, namespace, name, desired, ready, updated, " +
    " generation, observed_generation, progress_deadline_exceeded, " +
    " CAST((strftime('%s','now') - strftime('%s', first_seen_at)) / 60 AS INTEGER) AS age_minutes " +
    " FROM workload_rollouts " +
    "WHERE ready > 0 AND (" +
    "  progress_deadline_exceeded = 1 " +
    "  OR (updated < desired AND first_seen_at < datetime('now', ?))" +
    ")"
  ).all(`-${thresholdMinutes} minutes`) as WorkloadRolloutRow[];

  return rows.map(r => {
    const reason = r.progress_deadline_exceeded === 1
      ? 'ProgressDeadlineExceeded'
      : `${r.updated}/${r.desired} updated`;
    return {
      type: 'workload_rollout_stuck',
      hostId: r.cluster_id,
      target: workloadTarget(r.kind, r.namespace, r.name),
      message: `${r.kind} "${r.namespace}/${r.name}" rollout is stuck (${reason})`,
      value: r.updated,
      threshold: r.desired,
    };
  });
}

/**
 * Fire `pve_zfs_unhealthy` for any ZFS pool not in ONLINE state. Target =
 * pool_name so each pool fires/resolves independently. No config toggle —
 * pools that don't exist (non-PVE / non-ZFS) simply don't appear in the
 * table, mirroring how node_pressure handles k8s-only signals.
 */
function checkPveZfsUnhealthy(db: Database.Database): AlertItem[] {
  const rows = db.prepare(`
    SELECT host_id, pool_name, health, fragmentation
    FROM pve_zfs_pools
    WHERE health != 'ONLINE'
  `).all() as Array<{ host_id: string; pool_name: string; health: string; fragmentation: number | null }>;

  return rows.map(r => ({
    type: 'pve_zfs_unhealthy',
    hostId: r.host_id,
    target: r.pool_name,
    message: `ZFS pool "${r.pool_name}" on ${r.host_id} is ${r.health}. Run \`zpool status ${r.pool_name}\` for detail.`,
    value: r.health,
    threshold: 'ONLINE',
  }));
}

/**
 * Fire `pve_cluster_quorum_lost` when corosync has lost quorum (split brain
 * or multiple nodes offline). Target = 'quorum' (singleton — there's only
 * one quorum state per cluster). hostId = cluster_name so the alert dedups
 * across every PVE node that publishes the same status.
 */
function checkPveClusterQuorumLost(db: Database.Database): AlertItem[] {
  const rows = db.prepare(`
    SELECT cluster_name, total_nodes, online_nodes
    FROM pve_cluster_status
    WHERE quorate = 0
  `).all() as Array<{ cluster_name: string; total_nodes: number; online_nodes: number }>;

  return rows.map(r => ({
    type: 'pve_cluster_quorum_lost',
    hostId: r.cluster_name,
    target: 'quorum',
    message: `Proxmox cluster "${r.cluster_name}" has lost quorum (${r.online_nodes}/${r.total_nodes} nodes online). VMs/LXC cannot be started or migrated until quorum is restored.`,
    value: `${r.online_nodes}/${r.total_nodes}`,
    threshold: 'quorate=1',
  }));
}

/**
 * Fire `pve_storage_saturation` when a PVE storage pool exceeds the
 * (shared) disk threshold. Reuses `alerts.diskPercent` rather than
 * introducing a parallel knob — same semantic, the user already tuned it.
 * Inactive storages (mounted offline, missing disk) are skipped so we don't
 * alert on 0/0.
 */
function checkPveStorageSaturation(db: Database.Database, threshold: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT s.host_id, s.storage_name, s.storage_type, s.total_bytes, s.used_bytes,
           CASE WHEN s.total_bytes > 0
                THEN ROUND(s.used_bytes * 100.0 / s.total_bytes, 1)
                ELSE NULL END AS used_percent
    FROM pve_storage_snapshots s
    INNER JOIN (
      SELECT host_id, storage_name, MAX(collected_at) AS max_at
      FROM pve_storage_snapshots
      GROUP BY host_id, storage_name
    ) latest ON s.host_id = latest.host_id
            AND s.storage_name = latest.storage_name
            AND s.collected_at = latest.max_at
    WHERE s.active = 1
  `).all() as Array<{ host_id: string; storage_name: string; storage_type: string; total_bytes: number | null; used_bytes: number | null; used_percent: number | null }>;

  return rows
    .filter(r => r.used_percent !== null && r.used_percent > threshold)
    .map(r => ({
      type: 'pve_storage_saturation',
      hostId: r.host_id,
      target: r.storage_name,
      message: `Proxmox storage "${r.storage_name}" (${r.storage_type}) on ${r.host_id} at ${r.used_percent}% (threshold: ${threshold}%)`,
      value: r.used_percent,
      threshold,
    }));
}

/**
 * Fire `pve_backup_overdue` for any PVE guest whose last successful vzdump
 * is older than `warnDays` days, OR whose last_status is 'NEVER'. Target =
 * "<host_id>/<vmid>" so the alert dedups per-guest. Threshold of 0 disables
 * the check entirely (some homelabbers don't run vzdump and don't want the
 * noise).
 */
function checkPveBackupOverdue(db: Database.Database, warnDays: number): AlertItem[] {
  if (warnDays <= 0) return [];
  const cutoffSql = `datetime('now', '-${warnDays} days')`;
  // Pull the guest's display name from the latest container_snapshot so the
  // message uses "node/vmid" (matches the format ProxmoxRuntime stamps as
  // container_name in PR1) rather than just the bare vmid.
  const rows = db.prepare(`
    SELECT b.host_id, b.guest_vmid, b.last_backup_at, b.last_status,
           CAST((strftime('%s','now') - strftime('%s', COALESCE(b.last_backup_at, '1970-01-01'))) / 86400 AS INTEGER) AS age_days,
           (SELECT cs.container_name
              FROM container_snapshots cs
             WHERE cs.host_id = b.host_id AND cs.guest_vmid = b.guest_vmid
             ORDER BY cs.collected_at DESC LIMIT 1) AS guest_name
    FROM pve_guest_backups b
    WHERE b.last_status = 'NEVER'
       OR (b.last_backup_at IS NOT NULL AND b.last_backup_at < ${cutoffSql})
  `).all() as Array<{
    host_id: string; guest_vmid: number; last_backup_at: string | null;
    last_status: string; age_days: number; guest_name: string | null;
  }>;

  return rows.map(r => {
    const display = r.guest_name ?? `${r.host_id}/${r.guest_vmid}`;
    const detail = r.last_status === 'NEVER'
      ? 'never backed up'
      : `last backup ${r.age_days}d ago (threshold ${warnDays}d)`;
    return {
      type: 'pve_backup_overdue',
      hostId: r.host_id,
      target: String(r.guest_vmid),
      message: `Proxmox guest "${display}" — ${detail}.`,
      value: r.last_backup_at ?? 'never',
      threshold: `${warnDays}d`,
    };
  });
}

function checkEndpointDown(db: Database.Database, failureThreshold: number): AlertItem[] {
  const { getEndpoints, getLastNChecks } = require('../http-monitor/queries');
  const endpoints = (getEndpoints(db) as Array<{ id: number; name: string; url: string; enabled: number }>).filter(ep => ep.enabled);
  const alerts: AlertItem[] = [];

  for (const ep of endpoints) {
    const checks = getLastNChecks(db, ep.id, failureThreshold) as { is_up: number }[];
    if (checks.length < failureThreshold) continue;
    if (checks.every(c => c.is_up === 0)) {
      alerts.push({
        type: 'endpoint_down',
        hostId: 'hub',
        target: ep.name,
        message: `Endpoint "${ep.name}" (${ep.url}) is down (${failureThreshold} consecutive failures, threshold: ${failureThreshold})`,
        threshold: failureThreshold,
        value: ep.url,
      });
    }
  }
  return alerts;
}

// Alert types whose target is a container name. Host-scoped and endpoint
// alerts are excluded — their "stale" semantics are different (a host that
// stops reporting has its own offline signal, and endpoints are always
// polled by the hub).
const CONTAINER_ALERT_TYPES = new Set<string>([
  'container_down',
  'restart_loop',
  'high_cpu',
  'high_memory',
  'container_unhealthy',
  'container_memory_saturation',
  'container_cpu_saturation',
]);

// Generous window for "is the agent itself still reporting?" — used as a
// safety guard before auto-resolving container alerts on vanished targets.
// If the whole agent went dark every container looks removed, and we want
// the host-offline situation to stay visible instead.
const HOST_REPORTING_MINUTES = 15;

function checkResolutions(db: Database.Database, alertsConfig: AlertsConfig): AlertItem[] {
  const resolved: AlertItem[] = [];
  const activeAlerts = db.prepare(
    'SELECT id, host_id, alert_type, target, triggered_at FROM alert_state WHERE resolved_at IS NULL'
  ).all() as { id: number; host_id: string; alert_type: string; target: string; triggered_at: string }[];

  const containerRemovedStmt = db.prepare(
    'SELECT removed_at FROM containers WHERE host_id = ? AND container_name = ?'
  );
  const hostReportingStmt = db.prepare(
    "SELECT 1 FROM hosts WHERE host_id = ? AND last_seen >= datetime('now', ?) LIMIT 1"
  );

  // Per-cycle cache of "is this host still reporting?" — one row lookup per
  // unique host rather than per alert.
  const hostReporting = new Map<string, boolean>();
  const isHostReporting = (hostId: string): boolean => {
    const cached = hostReporting.get(hostId);
    if (cached !== undefined) return cached;
    const row = hostReportingStmt.get(hostId, `-${HOST_REPORTING_MINUTES} minutes`);
    const reporting = !!row;
    hostReporting.set(hostId, reporting);
    return reporting;
  };

  for (const alert of activeAlerts) {
    // Before running the type-specific resolver, auto-resolve any
    // container-scoped alert whose target has been removed (Docker rm,
    // k8s pod delete, completed Job pod). The `containers` registry is
    // the source of truth: `removed_at IS NOT NULL`, or no row at all,
    // means the container is no longer present.
    //
    // CRITICAL: only apply the stale auto-resolve path when the host
    // itself is still reporting. If the whole agent went dark, we leave
    // container alerts in their current state so the host-offline
    // situation stays visible instead of being masked by mass resolutions.
    if (CONTAINER_ALERT_TYPES.has(alert.alert_type) && isHostReporting(alert.host_id)) {
      const row = containerRemovedStmt.get(alert.host_id, alert.target) as
        { removed_at: string | null } | undefined;
      if (!row || row.removed_at !== null) {
        resolved.push({
          type: alert.alert_type,
          hostId: alert.host_id,
          target: alert.target,
          message: `Container "${alert.target}" on ${alert.host_id} is no longer reported by the agent (auto-resolved)`,
          triggeredAt: alert.triggered_at,
          isResolution: true,
        });
        continue;
      }
    }

    let isResolved = false;

    if (alert.alert_type === 'container_down') {
      const latest = db.prepare(
        'SELECT status FROM container_snapshots WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1'
      ).get(alert.host_id, alert.target) as { status: string } | undefined;
      isResolved = !!latest && latest.status === 'running';
    } else if (alert.alert_type === 'restart_loop') {
      const latest = db.prepare('SELECT restart_count FROM container_snapshots WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { restart_count: number } | undefined;
      const older = db.prepare('SELECT restart_count FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at <= datetime(\'now\', \'-30 minutes\') ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { restart_count: number } | undefined;
      if (latest && older) {
        isResolved = (latest.restart_count - older.restart_count) < alertsConfig.restartCount;
      }
    } else if (alert.alert_type === 'high_cpu') {
      const latest = db.prepare('SELECT cpu_percent FROM container_snapshots WHERE host_id = ? AND container_name = ? AND cpu_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { cpu_percent: number } | undefined;
      isResolved = !!latest && latest.cpu_percent <= alertsConfig.cpuPercent;
    } else if (alert.alert_type === 'high_memory') {
      const latest = db.prepare('SELECT memory_mb FROM container_snapshots WHERE host_id = ? AND container_name = ? AND memory_mb IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { memory_mb: number } | undefined;
      isResolved = !!latest && latest.memory_mb <= alertsConfig.memoryMb;
    } else if (alert.alert_type === 'container_memory_saturation') {
      const latest = db.prepare(`
        SELECT ROUND(memory_mb / memory_limit_mb * 100, 1) AS percent
        FROM container_snapshots
        WHERE host_id = ? AND container_name = ?
          AND memory_limit_mb IS NOT NULL AND memory_mb IS NOT NULL
        ORDER BY collected_at DESC LIMIT 1
      `).get(alert.host_id, alert.target) as { percent: number } | undefined;
      isResolved = !!latest && latest.percent <= alertsConfig.containerMemoryLimitPercent;
    } else if (alert.alert_type === 'container_cpu_saturation') {
      const latest = db.prepare(
        'SELECT cpu_limit_percent FROM container_snapshots WHERE host_id = ? AND container_name = ? AND cpu_limit_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1'
      ).get(alert.host_id, alert.target) as { cpu_limit_percent: number } | undefined;
      isResolved = !!latest && latest.cpu_limit_percent <= alertsConfig.containerCpuLimitPercent;
    } else if (alert.alert_type === 'disk_full') {
      const latest = db.prepare('SELECT used_percent FROM disk_snapshots WHERE host_id = ? AND mount_point = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { used_percent: number } | undefined;
      isResolved = !!latest && latest.used_percent <= alertsConfig.diskPercent;
    } else if (alert.alert_type === 'high_host_cpu') {
      const latest = db.prepare('SELECT cpu_percent FROM host_snapshots WHERE host_id = ? AND cpu_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id) as { cpu_percent: number } | undefined;
      isResolved = !!latest && latest.cpu_percent <= alertsConfig.hostCpuPercent;
    } else if (alert.alert_type === 'low_host_memory') {
      const latest = db.prepare('SELECT memory_available_mb FROM host_snapshots WHERE host_id = ? AND memory_available_mb IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id) as { memory_available_mb: number } | undefined;
      isResolved = !!latest && latest.memory_available_mb >= alertsConfig.hostMemoryAvailableMb;
    } else if (alert.alert_type === 'high_load') {
      const latest = db.prepare('SELECT load_5 FROM host_snapshots WHERE host_id = ? AND load_5 IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id) as { load_5: number } | undefined;
      isResolved = !!latest && latest.load_5 <= alertsConfig.hostLoadThreshold;
    } else if (alert.alert_type === 'container_unhealthy') {
      const latest = db.prepare('SELECT health_status FROM container_snapshots WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { health_status: string } | undefined;
      isResolved = !!latest && latest.health_status !== 'unhealthy';
    } else if (alert.alert_type === 'endpoint_down') {
      // If the endpoint was deleted or disabled, the http-monitor stops
      // probing it — no new is_up=1 check is ever going to roll in. Treat
      // that as resolved so the alert doesn't sit active forever and the
      // user can clean it up via DELETE. Mirrors the cert_* handlers below.
      const { getEndpoints, getLastNChecks } = require('../http-monitor/queries');
      const ep = (getEndpoints(db) as Array<{ id: number; name: string; enabled?: number }>).find(e => e.name === alert.target);
      if (!ep || ep.enabled === 0) {
        isResolved = true;
      } else {
        const checks = getLastNChecks(db, ep.id, 1) as { is_up: number }[];
        isResolved = checks.length > 0 && checks[0].is_up === 1;
      }
    } else if (alert.alert_type === 'cert_expired' || alert.alert_type === 'cert_expiring_soon' || alert.alert_type === 'cert_invalid') {
      // Resolved when the latest TLS probe shows the cert is healthy and
      // (for expiring_soon) past the warn window. If the endpoint was
      // deleted or is no longer https, that also counts as resolved.
      const ep = db.prepare(`
        SELECT id, url, tls_expires_at, tls_error, tls_last_checked_at
        FROM http_endpoints WHERE name = ? AND enabled = 1
      `).get(alert.target) as { id: number; url: string; tls_expires_at: string | null; tls_error: string | null; tls_last_checked_at: string | null } | undefined;
      if (!ep || !ep.url.startsWith('https://')) {
        isResolved = true;
      } else if (ep.tls_last_checked_at) {
        const expiryMs = ep.tls_expires_at ? Date.parse(ep.tls_expires_at) : NaN;
        const hasExpiry = Number.isFinite(expiryMs);
        const stillExpired = ep.tls_error === 'expired' || (hasExpiry && expiryMs < Date.now());
        const stillInvalid = !!ep.tls_error && !TLS_TRANSIENT_ERRORS.has(ep.tls_error) && ep.tls_error !== 'expired';
        if (alert.alert_type === 'cert_expired') {
          isResolved = !stillExpired;
        } else if (alert.alert_type === 'cert_invalid') {
          isResolved = !stillInvalid;
        } else {
          // cert_expiring_soon: clear when no longer in the warn window AND not expired
          const warn = alertsConfig.certExpiryWarnDays || 14;
          const daysLeft = hasExpiry ? (expiryMs - Date.now()) / 86400000 : Infinity;
          isResolved = !stillExpired && !stillInvalid && daysLeft > warn;
        }
      }
    } else if (alert.alert_type === 'host_offline') {
      // Resolved when the host has reported within the configured window.
      const windowMinutes = alertsConfig.hostOfflineMinutes || 15;
      const row = db.prepare(
        "SELECT 1 FROM hosts WHERE host_id = ? AND last_seen >= datetime('now', ?) LIMIT 1"
      ).get(alert.host_id, `-${windowMinutes} minutes`);
      isResolved = !!row;
    } else if (alert.alert_type === 'node_pressure') {
      // Resolved when the condition is no longer True (flipped back to
      // False) — or the row is gone entirely (host removed / non-k8s now).
      const row = db.prepare(
        `SELECT 1 FROM node_conditions WHERE host_id = ? AND type = ? AND status = 'True'`
      ).get(alert.host_id, alert.target);
      isResolved = !row;
    } else if (alert.alert_type === 'node_not_ready') {
      // Resolved when Ready is True again (or the row is gone entirely).
      const row = db.prepare(
        `SELECT 1 FROM node_conditions WHERE host_id = ? AND type = 'Ready' AND status != 'True'`
      ).get(alert.host_id);
      isResolved = !row;
    } else if (alert.alert_type === 'pod_pending') {
      // Resolved when the pod is no longer in `pending_pods` (left Pending
      // or no longer exists). target is "namespace/pod_name", host_id is
      // the cluster_id — see checkPodPending.
      const slash = alert.target.indexOf('/');
      if (slash > 0) {
        const ns = alert.target.slice(0, slash);
        const pod = alert.target.slice(slash + 1);
        const row = db.prepare(
          'SELECT 1 FROM pending_pods WHERE cluster_id = ? AND namespace = ? AND pod_name = ?'
        ).get(alert.host_id, ns, pod);
        isResolved = !row;
      }
    } else if (alert.alert_type === 'pve_zfs_unhealthy') {
      // Resolved when the pool is back to ONLINE — or the row is gone
      // (zpool destroyed, host removed). target = pool_name.
      const row = db.prepare(
        `SELECT health FROM pve_zfs_pools WHERE host_id = ? AND pool_name = ?`
      ).get(alert.host_id, alert.target) as { health: string } | undefined;
      isResolved = !row || row.health === 'ONLINE';
    } else if (alert.alert_type === 'pve_cluster_quorum_lost') {
      // Resolved when corosync regains quorum, or the cluster row is gone.
      // hostId = cluster_name (cluster-scoped, not a real host).
      const row = db.prepare(
        `SELECT quorate FROM pve_cluster_status WHERE cluster_name = ?`
      ).get(alert.host_id) as { quorate: number } | undefined;
      isResolved = !row || row.quorate === 1;
    } else if (alert.alert_type === 'pve_backup_overdue') {
      // target = vmid (string). Resolved when last_backup_at is back within
      // the warn window AND the status flipped to OK — so a fresh failure
      // (status='FAILED' even with old date) keeps the alert open. Or the
      // row vanished entirely (guest destroyed/migrated).
      const warnDays = alertsConfig.pveBackupAgeWarnDays ?? 7;
      const cutoffSql = `datetime('now', '-${warnDays} days')`;
      const row = db.prepare(
        `SELECT last_backup_at, last_status FROM pve_guest_backups WHERE host_id = ? AND guest_vmid = ?`
      ).get(alert.host_id, Number(alert.target)) as { last_backup_at: string | null; last_status: string } | undefined;
      if (!row) {
        isResolved = true;
      } else if (row.last_status === 'OK' && row.last_backup_at) {
        const stillOld = (db.prepare(
          `SELECT (julianday(?) < julianday(${cutoffSql})) AS old`
        ).get(row.last_backup_at) as { old: number }).old === 1;
        isResolved = !stillOld;
      }
    } else if (alert.alert_type === 'pve_storage_saturation') {
      // Resolved when latest snapshot is back under the disk threshold, or
      // the storage no longer reports (decommissioned). Mirrors disk_full.
      const latest = db.prepare(`
        SELECT CASE WHEN total_bytes > 0
                    THEN ROUND(used_bytes * 100.0 / total_bytes, 1)
                    ELSE NULL END AS percent
        FROM pve_storage_snapshots
        WHERE host_id = ? AND storage_name = ?
        ORDER BY collected_at DESC LIMIT 1
      `).get(alert.host_id, alert.target) as { percent: number | null } | undefined;
      isResolved = !latest || latest.percent === null || latest.percent <= alertsConfig.diskPercent;
    } else if (alert.alert_type === 'workload_unavailable'
            || alert.alert_type === 'workload_degraded'
            || alert.alert_type === 'workload_rollout_stuck') {
      // target = "Kind/namespace/name", host_id = cluster_id. Resolved when
      // the row is gone OR the specific condition has cleared. The three
      // alerts are mutually-exclusive: ready=0 → unavailable, partial →
      // degraded, full but updates pending → stuck. So when ready transitions
      // up, unavailable resolves and degraded may trip; when ready hits
      // desired, both unavailable and degraded resolve.
      const parts = alert.target.split('/');
      if (parts.length === 3) {
        const [kind, ns, name] = parts;
        const row = db.prepare(
          'SELECT desired, ready, updated, progress_deadline_exceeded ' +
          'FROM workload_rollouts ' +
          'WHERE cluster_id = ? AND kind = ? AND namespace = ? AND name = ?'
        ).get(alert.host_id, kind, ns, name) as
          { desired: number; ready: number; updated: number; progress_deadline_exceeded: number } | undefined;
        if (!row) {
          isResolved = true;
        } else if (alert.alert_type === 'workload_unavailable') {
          isResolved = row.ready > 0;
        } else if (alert.alert_type === 'workload_degraded') {
          isResolved = row.ready === 0 || row.ready >= row.desired;
        } else /* workload_rollout_stuck */ {
          isResolved = row.progress_deadline_exceeded !== 1 && row.updated >= row.desired;
        }
      }
    }

    if (isResolved) {
      resolved.push({
        type: alert.alert_type,
        hostId: alert.host_id,
        target: alert.target,
        message: getResolutionMessage(alert.alert_type, alert.target, alert.host_id),
        triggeredAt: alert.triggered_at,
        isResolution: true,
      });
    }
  }
  return resolved;
}

function getResolutionMessage(type: string, target: string, hostId: string): string {
  const on = ` on ${hostId}`;
  switch (type) {
    case 'container_down': return `Container "${target}"${on} is running again`;
    case 'restart_loop': return `Container "${target}"${on} restart loop resolved`;
    case 'high_cpu': return `Container "${target}"${on} CPU back to normal`;
    case 'high_memory': return `Container "${target}"${on} memory back to normal`;
    case 'disk_full': return `Disk "${target}"${on} usage back to normal`;
    case 'high_host_cpu': return `Host${on} CPU back to normal`;
    case 'low_host_memory': return `Host${on} memory back to normal`;
    case 'high_load': return `Host${on} load back to normal`;
    case 'host_offline': return `Host "${hostId}" is back online`;
    case 'container_unhealthy': return `Container "${target}"${on} is healthy again`;
    case 'endpoint_down': return `Endpoint "${target}" is reachable again`;
    case 'node_pressure': return `Node${on} ${target} cleared`;
    case 'node_not_ready': return `Node "${hostId}" is Ready again`;
    case 'container_memory_saturation': return `Container "${target}"${on} memory back under limit`;
    case 'container_cpu_saturation': return `Container "${target}"${on} CPU back under limit`;
    case 'cert_expired': return `Certificate for "${target}" is no longer expired`;
    case 'cert_expiring_soon': return `Certificate for "${target}" is no longer expiring soon`;
    case 'cert_invalid': return `Certificate for "${target}" is valid again`;
    case 'pod_pending': return `Pod "${target}" is no longer Pending`;
    case 'workload_unavailable': return `Workload "${target}" has Ready replicas again`;
    case 'workload_degraded': return `Workload "${target}" is fully Ready`;
    case 'workload_rollout_stuck': return `Workload "${target}" rollout is progressing`;
    case 'pve_zfs_unhealthy': return `ZFS pool "${target}"${on} is back to ONLINE`;
    case 'pve_cluster_quorum_lost': return `Proxmox cluster "${hostId}" regained quorum`;
    case 'pve_storage_saturation': return `Proxmox storage "${target}"${on} usage back to normal`;
    case 'pve_backup_overdue': return `Proxmox guest VMID ${target}${on} has a fresh successful backup`;
    default: return `Alert resolved for ${target}${on}`;
  }
}

/**
 * Process alerts: handle cooldown, deduplication, and DB state.
 */
function processAlerts(db: Database.Database, config: EvaluatorConfig, { triggered, resolved }: EvaluationResult): AlertItem[] {
  const toSend: AlertItem[] = [];
  const cooldownMinutes = config.alerts.cooldownMinutes;
  const backoff = config.alerts.reminderBackoff !== false;
  const capMinutes = config.alerts.reminderMaxMinutes ?? 1440;

  for (const alert of triggered) {
    const active = db.prepare(`
      SELECT id, last_notified, notify_count, silenced_until FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target) as { id: number; last_notified: string; notify_count: number; silenced_until: string | null } | undefined;

    if (!active) {
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message, trigger_value, threshold)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, ?, ?, ?)
      `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null);
      toSend.push({ ...alert, reminderNumber: 0 });
    } else {
      // Silence guard — block reminders entirely while silenced_until is in the
      // future. Does NOT reset notify_count, so backoff resumes at the same
      // step on unsilence. The initial alert above is unaffected.
      if (active.silenced_until) {
        const stillSilenced = (db.prepare(
          "SELECT (julianday(?) > julianday('now')) as still"
        ).get(active.silenced_until) as { still: number }).still === 1;
        if (stillSilenced) continue;
      }

      const minutesSinceLast = (db.prepare(
        "SELECT (julianday('now') - julianday(?)) * 1440 as minutes"
      ).get(active.last_notified) as { minutes: number }).minutes;

      const requiredGap = requiredReminderGap(active.notify_count, cooldownMinutes, capMinutes, backoff);
      if (minutesSinceLast >= requiredGap) {
        const newCount = active.notify_count + 1;
        db.prepare('UPDATE alert_state SET last_notified = datetime(\'now\'), notify_count = ? WHERE id = ?').run(newCount, active.id);
        toSend.push({ ...alert, reminderNumber: newCount - 1 });
      }
    }
  }

  for (const alert of resolved) {
    db.prepare(
      "UPDATE alert_state SET resolved_at = datetime('now') WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL"
    ).run(alert.hostId, alert.type, alert.target);
    toSend.push(alert);
  }

  return toSend;
}

/**
 * Main entry point: evaluate, process, and send alerts.
 */
async function runAlerts(db: Database.Database, config: EvaluatorConfig): Promise<void> {
  if (!config.alerts.enabled) return;

  // Check if alerts are snoozed (e.g. during updates)
  try {
    const { isSnoozed } = require('../alert-snooze');
    if (isSnoozed()) {
      logger.info('alerts', 'Alerts snoozed — skipping evaluation');
      return;
    }
  } catch { /* alert-snooze module not available */ }

  const evaluation = evaluateAlerts(db, config);
  const toSend = processAlerts(db, config, evaluation);

  if (toSend.length === 0) return;

  for (const alert of toSend) {
    try {
      await sendAlert(alert, config, db);
      const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber! > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
      logger.info('alerts', `${label}: ${alert.message}`);
    } catch (err) {
      logger.error('alerts', `Failed to send alert: ${alert.message}`, err);
    }

    // Dispatch to webhooks (independent of email)
    try {
      const { dispatchAlertWebhooks } = require('../../../shared/webhooks/sender');
      await dispatchAlertWebhooks(db, alert);
    } catch (err) {
      logger.error('alerts', `Webhook dispatch failed: ${alert.message}`, err);
    }
  }
}

module.exports = { evaluateAlerts, processAlerts, runAlerts, requiredReminderGap };
