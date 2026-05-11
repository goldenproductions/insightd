import type Database from 'better-sqlite3';
import logger = require('../utils/logger');
const { sendAlert } = require('./sender');
const { findActiveParent, findActiveChildren, DEPS } = require('./dependencies');
const { buildAftermath } = require('./aftermath');
const { getRule } = require('./rules');
const { effectiveSeverity } = require('./severity');

interface AlertItem {
  type: string;
  hostId: string;
  target: string;
  message: string;
  value?: any;
  threshold?: any;
  triggeredAt?: string;
  isResolution?: boolean;
  /** Resolve the alert in the DB but skip email/webhook notification. Used
   *  when retiring an alert subtype so existing rows clear without spamming. */
  isSilentResolution?: boolean;
  reminderNumber?: number;
}

interface AlertsConfig {
  enabled: boolean;
  containerDown: boolean;
  restartCount: number;
  cpuPercent: number;
  memoryMb: number;
  diskPercent: number;
  hostOffline?: boolean;
  hostOfflineMinutes?: number;
  endpointDown?: boolean;
  endpointFailureThreshold?: number;
  certExpiry?: boolean;
  certExpiryWarnDays?: number;
  cooldownMinutes: number;
  reminderBackoff?: boolean;
  reminderMaxMinutes?: number;
  /** Minutes a condition must persist before the first mail goes out; same gate
   *  applies to resolutions. 0 reproduces legacy instant-mail behavior. */
  flapStabilizeMinutes?: number;
  mailCriticalOnly?: boolean;
  suppressDependents?: boolean;
  diskCriticalPercent?: number;
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

  // Get all known hosts
  const hosts = db.prepare('SELECT DISTINCT host_id FROM container_snapshots').all() as { host_id: string }[];

  for (const { host_id } of hosts) {
    if (alerts.containerDown) {
      triggered.push(...checkContainerDown(db, host_id));
    }
    if (alerts.restartCount > 0) {
      triggered.push(...checkRestartLoop(db, host_id, alerts.restartCount));
    }
    if (alerts.cpuPercent > 0) {
      triggered.push(...checkHighCpu(db, host_id, alerts.cpuPercent));
    }
    if (alerts.memoryMb > 0) {
      triggered.push(...checkHighMemory(db, host_id, alerts.memoryMb));
    }
  }

  // Disk — check across all hosts
  if (alerts.diskPercent > 0) {
    triggered.push(...checkDiskFull(db, alerts.diskPercent));
  }

  // Host offline — fires when an agent stops reporting for longer than the
  // configured window. Queries the `hosts` table directly (authoritative
  // last_seen), not host_snapshots which can be pruned by retention.
  if (alerts.hostOffline && (alerts.hostOfflineMinutes || 0) > 0) {
    triggered.push(...checkHostOffline(db, alerts.hostOfflineMinutes || 15));
  }

  // HTTP endpoints — hub-level checks
  if (alerts.endpointDown !== false) {
    triggered.push(...checkEndpointDown(db, alerts.endpointFailureThreshold || 3));
  }

  // TLS certificate checks
  if (alerts.certExpiry !== false) {
    triggered.push(...checkCertAlerts(db, alerts.certExpiryWarnDays || 14));
  }

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
    // Successfully-completed one-shots (exited with code 0) aren't failures.
    if (latest.status === 'exited' && latest.exit_code === 0) continue;
    if ((latest.status === 'exited' || latest.status === 'dead') && previous.status === 'running') {
      alerts.push({
        type: 'container_down',
        hostId,
        target: container_name,
        message: `Container "${container_name}" on ${hostId} is down`,
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
      SELECT restart_count FROM container_snapshots
      WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name) as { restart_count: number } | undefined;

    const older = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND collected_at <= datetime('now', '-30 minutes')
      ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name) as { restart_count: number } | undefined;

    if (!latest || !older) continue;
    const delta = latest.restart_count - older.restart_count;
    if (delta >= threshold) {
      alerts.push({
        type: 'restart_loop',
        hostId,
        target: container_name,
        message: `Container "${container_name}" on ${hostId} restarted ${delta} times in 30 minutes`,
        value: delta,
      });
    }
  }
  return alerts;
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
      message: `Container "${r.container_name}" on ${hostId} CPU at ${r.cpu_percent}%`,
      value: r.cpu_percent,
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
      message: `Container "${r.container_name}" on ${hostId} using ${Math.round(r.memory_mb)}MB RAM`,
      value: r.memory_mb,
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
      message: `Disk "${r.mount_point}" on ${r.host_id} at ${r.used_percent}% (${r.used_gb}/${r.total_gb}GB)`,
      value: r.used_percent,
    }));
}

/**
 * Fire host_offline for any host whose agent hasn't reported in
 * `thresholdMinutes`. Queries the `hosts` table directly so the check
 * keeps working for hosts whose snapshot rows have aged out of retention.
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

const TLS_TRANSIENT_ERRORS = new Set(['timeout', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'tls-error']);

interface CertEndpointRow {
  id: number;
  name: string;
  url: string;
  tls_expires_at: string | null;
  tls_error: string | null;
}

function checkCertAlerts(db: Database.Database, warnDays: number): AlertItem[] {
  const rows = db.prepare(`
    SELECT id, name, url, tls_expires_at, tls_error
    FROM http_endpoints
    WHERE enabled = 1 AND url LIKE 'https://%' AND tls_last_checked_at IS NOT NULL
  `).all() as CertEndpointRow[];

  const out: AlertItem[] = [];
  const now = Date.now();
  for (const ep of rows) {
    const expiryMs = ep.tls_expires_at ? Date.parse(ep.tls_expires_at) : NaN;
    const hasExpiry = Number.isFinite(expiryMs);
    if (ep.tls_error === 'expired' || (hasExpiry && expiryMs < now)) {
      out.push({ type: 'cert_expired', hostId: 'hub', target: ep.name, message: `Certificate for "${ep.name}" (${ep.url}) has expired`, value: ep.tls_expires_at });
      continue;
    }
    if (ep.tls_error && !TLS_TRANSIENT_ERRORS.has(ep.tls_error) && ep.tls_error !== 'expired') {
      out.push({ type: 'cert_invalid', hostId: 'hub', target: ep.name, message: `Certificate for "${ep.name}" (${ep.url}) is invalid: ${ep.tls_error}`, value: ep.tls_error });
      continue;
    }
    if (hasExpiry && warnDays > 0) {
      const daysLeft = (expiryMs - now) / 86400000;
      if (daysLeft <= warnDays) {
        const rounded = Math.max(0, Math.ceil(daysLeft));
        out.push({ type: 'cert_expiring_soon', hostId: 'hub', target: ep.name, message: `Certificate for "${ep.name}" (${ep.url}) expires in ${rounded} day${rounded === 1 ? '' : 's'}`, value: ep.tls_expires_at, threshold: warnDays });
      }
    }
  }
  return out;
}

function checkEndpointDown(db: Database.Database, failureThreshold: number): AlertItem[] {
  let getEndpoints: any, getLastNChecks: any;
  try {
    const queries = require('../../hub/src/http-monitor/queries') as any;
    getEndpoints = queries.getEndpoints;
    getLastNChecks = queries.getLastNChecks;
  } catch {
    return []; // http-monitor module not available in standalone mode without hub
  }
  const endpoints = getEndpoints(db).filter((ep: any) => ep.enabled);
  const alerts: AlertItem[] = [];

  for (const ep of endpoints) {
    const checks = getLastNChecks(db, ep.id, failureThreshold) as { is_up: number }[];
    if (checks.length < failureThreshold) continue;
    if (checks.every((c: { is_up: number }) => c.is_up === 0)) {
      alerts.push({
        type: 'endpoint_down',
        hostId: 'hub',
        target: ep.name,
        message: `Endpoint "${ep.name}" (${ep.url}) is down (${failureThreshold} consecutive failures)`,
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
    } else if (alert.alert_type === 'disk_full') {
      const latest = db.prepare('SELECT used_percent FROM disk_snapshots WHERE host_id = ? AND mount_point = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target) as { used_percent: number } | undefined;
      isResolved = !!latest && latest.used_percent <= alertsConfig.diskPercent;
    } else if (alert.alert_type === 'endpoint_down') {
      try {
        const { getEndpoints, getLastNChecks } = require('../../hub/src/http-monitor/queries') as any;
        const ep = getEndpoints(db).find((e: any) => e.name === alert.target);
        // Endpoint deleted or disabled → no further checks will ever roll
        // in, so the alert is resolved by definition. Mirrors cert_*.
        if (!ep || ep.enabled === 0) {
          isResolved = true;
        } else {
          const checks = getLastNChecks(db, ep.id, 1) as { is_up: number }[];
          isResolved = checks.length > 0 && checks[0].is_up === 1;
        }
      } catch {
        // http-monitor module not available
      }
    } else if (alert.alert_type === 'cert_expired' || alert.alert_type === 'cert_expiring_soon' || alert.alert_type === 'cert_invalid') {
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
          const warn = alertsConfig.certExpiryWarnDays || 14;
          const daysLeft = hasExpiry ? (expiryMs - Date.now()) / 86400000 : Infinity;
          isResolved = !stillExpired && !stillInvalid && daysLeft > warn;
        }
      }
    } else if (alert.alert_type === 'host_offline') {
      const windowMinutes = alertsConfig.hostOfflineMinutes || 15;
      const row = db.prepare(
        "SELECT 1 FROM hosts WHERE host_id = ? AND last_seen >= datetime('now', ?) LIMIT 1"
      ).get(alert.host_id, `-${windowMinutes} minutes`);
      isResolved = !!row;
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
    case 'host_offline': return `Host "${hostId}" is back online`;
    case 'endpoint_down': return `Endpoint "${target}" is reachable again`;
    case 'cert_expired': return `Certificate for "${target}" is no longer expired`;
    case 'cert_expiring_soon': return `Certificate for "${target}" is no longer expiring soon`;
    case 'cert_invalid': return `Certificate for "${target}" is valid again`;
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
  const stabilizeMin = Math.max(0, config.alerts.flapStabilizeMinutes ?? 5);
  const suppress = config.alerts.suppressDependents !== false;

  const minutesSince = (ts: string | null): number => {
    if (!ts) return Number.POSITIVE_INFINITY;
    return (db.prepare("SELECT (julianday('now') - julianday(?)) * 1440 AS m").get(ts) as { m: number }).m;
  };

  for (const alert of triggered) {
    // === Retroactive suppression: parent type firing this cycle ===
    if (suppress) {
      const isParentType = DEPS.some((d: any) => d.parent === alert.type);
      if (isParentType) {
        let parentRow = db.prepare(
          'SELECT id FROM alert_state WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL'
        ).get(alert.hostId, alert.type, alert.target) as { id: number } | undefined;
        if (!parentRow) {
          const info = db.prepare(`
            INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, message, trigger_value, threshold)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, datetime('now'), ?, ?, ?)
          `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null);
          parentRow = { id: Number(info.lastInsertRowid) };
        }
        const children = findActiveChildren(db, { alert_type: alert.type, host_id: alert.hostId });
        const stamp = db.prepare('UPDATE alert_state SET suppressed_by_state_id = ? WHERE id = ? AND suppressed_by_state_id IS NULL AND resolved_at IS NULL');
        for (const c of children) stamp.run(parentRow.id, c.id);
        // Fall through — parent itself still flows through the mail path below.
      }
    }

    const active = db.prepare(`
      SELECT id, triggered_at, last_notified, notify_count, silenced_until,
             pending_since, resolved_pending_since
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target) as
      { id: number; triggered_at: string; last_notified: string; notify_count: number; silenced_until: string | null; pending_since: string | null; resolved_pending_since: string | null } | undefined;

    if (!active) {
      // First sighting — record state, NO mail until stabilize elapses.
      // Also check if a parent is already active and stamp at birth.
      let parentId: number | null = null;
      if (suppress) {
        const p = findActiveParent(db, alert);
        if (p) parentId = p.id;
      }
      const ins = db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, message, trigger_value, threshold, suppressed_by_state_id)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, datetime('now'), ?, ?, ?, ?)
      `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null, parentId);
      if (parentId !== null) continue;  // suppressed at birth — no mail
      if (stabilizeMin === 0) {
        // back-compat: immediately bump notify_count and mail
        db.prepare("UPDATE alert_state SET notify_count = 1, last_notified = datetime('now') WHERE id = ?").run(Number(ins.lastInsertRowid));
        toSend.push({ ...alert, reminderNumber: 0 });
      }
      continue;
    }

    // Existing row. Clear any pending-resolution state — alert is back.
    if (active.resolved_pending_since) {
      db.prepare('UPDATE alert_state SET resolved_pending_since = NULL WHERE id = ?').run(active.id);
    }

    if (active.silenced_until) {
      const stillSilenced = (db.prepare("SELECT (julianday(?) > julianday('now')) AS s").get(active.silenced_until) as { s: number }).s === 1;
      if (stillSilenced) continue;
    }

    if (active.notify_count === 0) {
      // Initial mail still pending. Apply suppression check before mailing.
      if (suppress) {
        const p = findActiveParent(db, alert);
        if (p) {
          db.prepare('UPDATE alert_state SET suppressed_by_state_id = ? WHERE id = ?').run(p.id, active.id);
          continue;
        }
      }
      if (minutesSince(active.pending_since) >= stabilizeMin) {
        db.prepare("UPDATE alert_state SET notify_count = 1, last_notified = datetime('now') WHERE id = ?").run(active.id);
        toSend.push({ ...alert, reminderNumber: 0 });
      }
      continue;
    }

    // Already mailed at least once — reminder cadence path (unchanged from prior behavior).
    const requiredGap = requiredReminderGap(active.notify_count, cooldownMinutes, capMinutes, backoff);
    if (minutesSince(active.last_notified) >= requiredGap) {
      const newCount = active.notify_count + 1;
      db.prepare("UPDATE alert_state SET last_notified = datetime('now'), notify_count = ? WHERE id = ?").run(newCount, active.id);
      toSend.push({ ...alert, reminderNumber: newCount - 1 });
    }
  }

  for (const alert of resolved) {
    const row = db.prepare(`
      SELECT id, notify_count, last_notified, resolved_pending_since
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target) as
      { id: number; notify_count: number; last_notified: string; resolved_pending_since: string | null } | undefined;

    if (!row) continue;

    if (row.notify_count === 0) {
      // Initial alert was never mailed — drop silently. No resolution email.
      db.prepare('DELETE FROM alert_state WHERE id = ?').run(row.id);
      continue;
    }

    if (stabilizeMin === 0 || alert.isSilentResolution) {
      // Send (or silently resolve) immediately.
      db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE id = ?").run(row.id);
      if (!alert.isSilentResolution) toSend.push(alert);
      continue;
    }

    if (!row.resolved_pending_since) {
      db.prepare("UPDATE alert_state SET resolved_pending_since = datetime('now') WHERE id = ?").run(row.id);
      continue;  // first sighting of recovery — wait stabilize
    }

    const pendMin = minutesSince(row.resolved_pending_since);
    const sinceLast = minutesSince(row.last_notified);
    if (pendMin >= stabilizeMin && sinceLast >= stabilizeMin) {
      db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE id = ?").run(row.id);
      toSend.push(alert);
    }
  }

  return toSend;
}

/**
 * Main entry point: evaluate, process, and send alerts.
 */
async function runAlerts(db: Database.Database, config: EvaluatorConfig): Promise<void> {
  if (!config.alerts.enabled) return;

  const evaluation = evaluateAlerts(db, config);
  const toSend = processAlerts(db, config, evaluation);

  if (toSend.length === 0) return;

  for (const alert of toSend) {
    const rule = getRule(db, alert.type);
    if (!rule.enabled) {
      continue;  // muted entirely
    }
    const sev = effectiveSeverity(alert, rule, config.alerts.diskCriticalPercent ?? 95);
    const sevAllowed = config.alerts.mailCriticalOnly === false ? true : sev === 'critical';

    if (rule.mail && sevAllowed) {
      try {
        // Re-resolve at call time so tests can stub sender via require cache.
        const { sendAlert: sendAlertFn } = require('./sender');
        await sendAlertFn({ ...alert, severity: sev }, config, db);
        const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber! > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
        logger.info('alerts', `${label} [${sev}]: ${alert.message}`);
      } catch (err) {
        logger.error('alerts', `Failed to send alert: ${alert.message}`, err);
      }
    }

    if (rule.webhook) {
      try {
        const { dispatchAlertWebhooks } = require('../../shared/webhooks/sender');
        await dispatchAlertWebhooks(db, { ...alert, severity: sev });
      } catch (err) {
        logger.error('alerts', `Webhook dispatch failed: ${alert.message}`, err);
      }
    }
  }

  // Aftermath: for each parent that just resolved this cycle, send one
  // consolidated summary in addition to the individual resolution mail.
  for (const alert of toSend) {
    if (!alert.isResolution) continue;
    const isParentType = DEPS.some((d: any) => d.parent === alert.type);
    if (!isParentType) continue;
    const parentRow = db.prepare(`
      SELECT id, alert_type, host_id, target, triggered_at
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ?
      ORDER BY id DESC LIMIT 1
    `).get(alert.hostId, alert.type, alert.target) as any;
    if (!parentRow) continue;
    const summary = buildAftermath(db, parentRow);
    if (summary.stillFiring.length === 0 && summary.cleared.length === 0) continue;
    try {
      const { sendAftermath } = require('./sender');
      await sendAftermath(summary, config);
      logger.info('alerts', `AFTERMATH: ${summary.cleared.length} cleared, ${summary.stillFiring.length} still firing under ${parentRow.alert_type} on ${parentRow.host_id}`);
    } catch (err) {
      logger.error('alerts', 'Aftermath send failed', err);
    }
  }
}

module.exports = { evaluateAlerts, processAlerts, runAlerts, requiredReminderGap };
