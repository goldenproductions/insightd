const logger = require('../utils/logger');
const { sendAlert } = require('./sender');

/**
 * Evaluate all alert conditions against the latest data.
 * Checks all hosts. Returns { triggered: [], resolved: [] }
 */
function evaluateAlerts(db, config) {
  const alerts = config.alerts;
  const triggered = [];
  const resolved = [];

  // Get all known hosts
  const hosts = db.prepare('SELECT DISTINCT host_id FROM container_snapshots').all();

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

  // Check for resolutions of active alerts
  resolved.push(...checkResolutions(db, alerts));

  return { triggered, resolved };
}

function checkContainerDown(db, hostId) {
  const alerts = [];
  const containers = db.prepare(
    'SELECT DISTINCT container_name FROM container_snapshots WHERE host_id = ?'
  ).all(hostId);

  for (const { container_name } of containers) {
    const rows = db.prepare(`
      SELECT status, collected_at FROM container_snapshots
      WHERE host_id = ? AND container_name = ?
      ORDER BY collected_at DESC LIMIT 2
    `).all(hostId, container_name);

    if (rows.length < 2) continue;
    const [latest, previous] = rows;
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

function checkRestartLoop(db, hostId, threshold) {
  const alerts = [];
  const containers = db.prepare(
    'SELECT DISTINCT container_name FROM container_snapshots WHERE host_id = ?'
  ).all(hostId);

  for (const { container_name } of containers) {
    const latest = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name);

    const older = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND collected_at <= datetime('now', '-30 minutes')
      ORDER BY collected_at DESC LIMIT 1
    `).get(hostId, container_name);

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

function checkHighCpu(db, hostId, threshold) {
  const rows = db.prepare(`
    SELECT container_name, cpu_percent FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND cpu_percent IS NOT NULL AND status = 'running'
  `).all(hostId, hostId);

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

function checkHighMemory(db, hostId, threshold) {
  const rows = db.prepare(`
    SELECT container_name, memory_mb FROM container_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM container_snapshots WHERE host_id = ?
    ) AND memory_mb IS NOT NULL AND status = 'running'
  `).all(hostId, hostId);

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

function checkDiskFull(db, threshold) {
  const rows = db.prepare(`
    SELECT host_id, mount_point, used_percent, used_gb, total_gb FROM disk_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM disk_snapshots)
  `).all();

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

function checkResolutions(db, alertsConfig) {
  const resolved = [];
  const activeAlerts = db.prepare(
    'SELECT id, host_id, alert_type, target, triggered_at FROM alert_state WHERE resolved_at IS NULL'
  ).all();

  for (const alert of activeAlerts) {
    let isResolved = false;

    if (alert.alert_type === 'container_down') {
      const latest = db.prepare(
        'SELECT status FROM container_snapshots WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1'
      ).get(alert.host_id, alert.target);
      isResolved = latest && latest.status === 'running';
    } else if (alert.alert_type === 'restart_loop') {
      const latest = db.prepare('SELECT restart_count FROM container_snapshots WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target);
      const older = db.prepare('SELECT restart_count FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at <= datetime(\'now\', \'-30 minutes\') ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target);
      if (latest && older) {
        isResolved = (latest.restart_count - older.restart_count) < alertsConfig.restartCount;
      }
    } else if (alert.alert_type === 'high_cpu') {
      const latest = db.prepare('SELECT cpu_percent FROM container_snapshots WHERE host_id = ? AND container_name = ? AND cpu_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target);
      isResolved = latest && latest.cpu_percent <= alertsConfig.cpuPercent;
    } else if (alert.alert_type === 'high_memory') {
      const latest = db.prepare('SELECT memory_mb FROM container_snapshots WHERE host_id = ? AND container_name = ? AND memory_mb IS NOT NULL ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target);
      isResolved = latest && latest.memory_mb <= alertsConfig.memoryMb;
    } else if (alert.alert_type === 'disk_full') {
      const latest = db.prepare('SELECT used_percent FROM disk_snapshots WHERE host_id = ? AND mount_point = ? ORDER BY collected_at DESC LIMIT 1').get(alert.host_id, alert.target);
      isResolved = latest && latest.used_percent <= alertsConfig.diskPercent;
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

function getResolutionMessage(type, target, hostId) {
  const on = ` on ${hostId}`;
  switch (type) {
    case 'container_down': return `Container "${target}"${on} is running again`;
    case 'restart_loop': return `Container "${target}"${on} restart loop resolved`;
    case 'high_cpu': return `Container "${target}"${on} CPU back to normal`;
    case 'high_memory': return `Container "${target}"${on} memory back to normal`;
    case 'disk_full': return `Disk "${target}"${on} usage back to normal`;
    default: return `Alert resolved for ${target}${on}`;
  }
}

/**
 * Process alerts: handle cooldown, deduplication, and DB state.
 */
function processAlerts(db, config, { triggered, resolved }) {
  const toSend = [];
  const cooldownMinutes = config.alerts.cooldownMinutes;

  for (const alert of triggered) {
    const active = db.prepare(`
      SELECT id, last_notified, notify_count FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target);

    if (!active) {
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
      `).run(alert.hostId, alert.type, alert.target);
      toSend.push({ ...alert, reminderNumber: 0 });
    } else {
      const minutesSinceLast = db.prepare(
        "SELECT (julianday('now') - julianday(?)) * 1440 as minutes"
      ).get(active.last_notified).minutes;

      if (minutesSinceLast >= cooldownMinutes) {
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
async function runAlerts(db, config) {
  if (!config.alerts.enabled) return;

  const evaluation = evaluateAlerts(db, config);
  const toSend = processAlerts(db, config, evaluation);

  if (toSend.length === 0) return;

  for (const alert of toSend) {
    try {
      await sendAlert(alert, config);
      const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
      logger.info('alerts', `${label}: ${alert.message}`);
    } catch (err) {
      logger.error('alerts', `Failed to send alert: ${alert.message}`, err);
    }
  }
}

module.exports = { evaluateAlerts, processAlerts, runAlerts };
