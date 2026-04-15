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
  containerUnhealthy: boolean;
  excludeContainers: string;
  endpointDown: boolean | undefined;
  endpointFailureThreshold: number;
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
      SELECT status, collected_at FROM container_snapshots
      WHERE host_id = ? AND container_name = ?
      ORDER BY collected_at DESC LIMIT 2
    `).all(hostId, container_name) as { status: string; collected_at: string }[];

    if (rows.length < 2) continue;
    const [latest, previous] = rows;
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
        message: `Container "${container_name}" on ${hostId} restarted ${delta} times in 30 minutes (threshold: ${threshold})`,
        value: delta,
        threshold,
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

function checkContainerUnhealthy(db: Database.Database, hostId: string): AlertItem[] {
  const rows = db.prepare(`
    SELECT container_name, health_status, health_check_output FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND health_status = 'unhealthy'
  `).all(hostId, hostId) as { container_name: string; health_status: string; health_check_output: string | null }[];

  return rows.map(r => {
    const base = `Container "${r.container_name}" on ${hostId} is unhealthy`;
    const output = r.health_check_output?.slice(0, 200);
    return {
      type: 'container_unhealthy', hostId, target: r.container_name,
      message: output ? `${base} — ${output}` : base,
      value: 'unhealthy',
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
]);

// Generous window for "agent stopped reporting this container". The default
// collect interval is 5 minutes and the host detail page's live container
// list uses the same 15-minute filter, so this stays consistent with what
// the user already sees in the UI.
const STALE_CONTAINER_MINUTES = 15;

function checkResolutions(db: Database.Database, alertsConfig: AlertsConfig): AlertItem[] {
  const resolved: AlertItem[] = [];
  const activeAlerts = db.prepare(
    'SELECT id, host_id, alert_type, target, triggered_at FROM alert_state WHERE resolved_at IS NULL'
  ).all() as { id: number; host_id: string; alert_type: string; target: string; triggered_at: string }[];

  const recentSnapshotStmt = db.prepare(
    "SELECT 1 FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', ?) LIMIT 1"
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
    const row = hostReportingStmt.get(hostId, `-${STALE_CONTAINER_MINUTES} minutes`);
    const reporting = !!row;
    hostReporting.set(hostId, reporting);
    return reporting;
  };

  for (const alert of activeAlerts) {
    // Before running the type-specific resolver, auto-resolve any
    // container-scoped alert whose target hasn't been reported in the
    // recency window. Closes the leak where a deleted container (Docker
    // rm, k8s pod delete) leaves its last "bad" snapshot frozen forever.
    //
    // CRITICAL: only apply the "stale auto-resolve" path when the host
    // itself is still reporting. If the whole agent went dark, every
    // container on that host looks "stale" — auto-resolving their alerts
    // would silently clear real failures and mislead the operator into
    // thinking the problem was fixed. In that case we leave alerts in
    // their current state so the host-offline situation stays visible.
    if (CONTAINER_ALERT_TYPES.has(alert.alert_type) && isHostReporting(alert.host_id)) {
      const recent = recentSnapshotStmt.get(
        alert.host_id, alert.target, `-${STALE_CONTAINER_MINUTES} minutes`
      );
      if (!recent) {
        resolved.push({
          type: alert.alert_type,
          hostId: alert.host_id,
          target: alert.target,
          message: `Container "${alert.target}" on ${alert.host_id} is no longer reported by the agent (auto-resolved after ${STALE_CONTAINER_MINUTES}m)`,
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
      const { getEndpoints, getLastNChecks } = require('../http-monitor/queries');
      const ep = (getEndpoints(db) as Array<{ id: number; name: string }>).find(e => e.name === alert.target);
      if (ep) {
        const checks = getLastNChecks(db, ep.id, 1) as { is_up: number }[];
        isResolved = checks.length > 0 && checks[0].is_up === 1;
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
    case 'container_unhealthy': return `Container "${target}"${on} is healthy again`;
    case 'endpoint_down': return `Endpoint "${target}" is reachable again`;
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
