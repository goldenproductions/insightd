const logger = require('../utils/logger');
const { sendAlert } = require('./sender');

/**
 * Evaluate all alert conditions against the latest data.
 * Returns { triggered: [], resolved: [] }
 */
function evaluateAlerts(db, config) {
  const alerts = config.alerts;
  const triggered = [];
  const resolved = [];

  // Container down
  if (alerts.containerDown) {
    const downs = checkContainerDown(db);
    triggered.push(...downs);
  }

  // Restart loop
  if (alerts.restartCount > 0) {
    const restarts = checkRestartLoop(db, alerts.restartCount);
    triggered.push(...restarts);
  }

  // High CPU
  if (alerts.cpuPercent > 0) {
    const cpuAlerts = checkHighCpu(db, alerts.cpuPercent);
    triggered.push(...cpuAlerts);
  }

  // High memory
  if (alerts.memoryMb > 0) {
    const memAlerts = checkHighMemory(db, alerts.memoryMb);
    triggered.push(...memAlerts);
  }

  // Disk full
  if (alerts.diskPercent > 0) {
    const diskAlerts = checkDiskFull(db, alerts.diskPercent);
    triggered.push(...diskAlerts);
  }

  // Check for resolutions of active alerts
  const resolutions = checkResolutions(db, alerts);
  resolved.push(...resolutions);

  return { triggered, resolved };
}

/**
 * Check for containers that transitioned from running to exited/dead.
 */
function checkContainerDown(db) {
  const alerts = [];

  // Get the two most recent snapshots per container
  const containers = db.prepare(`
    SELECT DISTINCT container_name FROM container_snapshots
  `).all();

  for (const { container_name } of containers) {
    const rows = db.prepare(`
      SELECT status, collected_at FROM container_snapshots
      WHERE container_name = ?
      ORDER BY collected_at DESC LIMIT 2
    `).all(container_name);

    if (rows.length < 2) continue; // no history, skip

    const [latest, previous] = rows;
    if ((latest.status === 'exited' || latest.status === 'dead') && previous.status === 'running') {
      alerts.push({
        type: 'container_down',
        target: container_name,
        message: `Container "${container_name}" is down`,
        value: latest.status,
      });
    }
  }

  return alerts;
}

/**
 * Check for restart loops — restart_count increased by N in 30-minute window.
 */
function checkRestartLoop(db, threshold) {
  const alerts = [];

  const containers = db.prepare(`
    SELECT DISTINCT container_name FROM container_snapshots
  `).all();

  for (const { container_name } of containers) {
    const latest = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(container_name);

    const older = db.prepare(`
      SELECT restart_count FROM container_snapshots
      WHERE container_name = ? AND collected_at <= datetime('now', '-30 minutes')
      ORDER BY collected_at DESC LIMIT 1
    `).get(container_name);

    if (!latest || !older) continue;
    const delta = latest.restart_count - older.restart_count;
    if (delta >= threshold) {
      alerts.push({
        type: 'restart_loop',
        target: container_name,
        message: `Container "${container_name}" restarted ${delta} times in 30 minutes`,
        value: delta,
      });
    }
  }

  return alerts;
}

/**
 * Check for high CPU usage.
 */
function checkHighCpu(db, threshold) {
  const alerts = [];

  const rows = db.prepare(`
    SELECT container_name, cpu_percent FROM container_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM container_snapshots)
      AND cpu_percent IS NOT NULL AND status = 'running'
  `).all();

  for (const row of rows) {
    if (row.cpu_percent > threshold) {
      alerts.push({
        type: 'high_cpu',
        target: row.container_name,
        message: `Container "${row.container_name}" CPU at ${row.cpu_percent}%`,
        value: row.cpu_percent,
      });
    }
  }

  return alerts;
}

/**
 * Check for high memory usage.
 */
function checkHighMemory(db, threshold) {
  const alerts = [];

  const rows = db.prepare(`
    SELECT container_name, memory_mb FROM container_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM container_snapshots)
      AND memory_mb IS NOT NULL AND status = 'running'
  `).all();

  for (const row of rows) {
    if (row.memory_mb > threshold) {
      alerts.push({
        type: 'high_memory',
        target: row.container_name,
        message: `Container "${row.container_name}" using ${Math.round(row.memory_mb)}MB RAM`,
        value: row.memory_mb,
      });
    }
  }

  return alerts;
}

/**
 * Check for disk usage above threshold.
 */
function checkDiskFull(db, threshold) {
  const alerts = [];

  const rows = db.prepare(`
    SELECT mount_point, used_percent, used_gb, total_gb FROM disk_snapshots
    WHERE collected_at = (SELECT MAX(collected_at) FROM disk_snapshots)
  `).all();

  for (const row of rows) {
    if (row.used_percent > threshold) {
      alerts.push({
        type: 'disk_full',
        target: row.mount_point,
        message: `Disk "${row.mount_point}" at ${row.used_percent}% (${row.used_gb}/${row.total_gb}GB)`,
        value: row.used_percent,
      });
    }
  }

  return alerts;
}

/**
 * Check active alerts for resolution.
 */
function checkResolutions(db, alertsConfig) {
  const resolved = [];
  const activeAlerts = db.prepare(`
    SELECT id, alert_type, target, triggered_at FROM alert_state WHERE resolved_at IS NULL
  `).all();

  for (const alert of activeAlerts) {
    let isResolved = false;

    if (alert.alert_type === 'container_down') {
      const latest = db.prepare(`
        SELECT status FROM container_snapshots
        WHERE container_name = ? ORDER BY collected_at DESC LIMIT 1
      `).get(alert.target);
      isResolved = latest && latest.status === 'running';
    } else if (alert.alert_type === 'restart_loop') {
      // Resolve if no restarts in the last 30 minutes
      const latest = db.prepare(`SELECT restart_count FROM container_snapshots WHERE container_name = ? ORDER BY collected_at DESC LIMIT 1`).get(alert.target);
      const older = db.prepare(`SELECT restart_count FROM container_snapshots WHERE container_name = ? AND collected_at <= datetime('now', '-30 minutes') ORDER BY collected_at DESC LIMIT 1`).get(alert.target);
      if (latest && older) {
        isResolved = (latest.restart_count - older.restart_count) < alertsConfig.restartCount;
      }
    } else if (alert.alert_type === 'high_cpu') {
      const latest = db.prepare(`SELECT cpu_percent FROM container_snapshots WHERE container_name = ? AND cpu_percent IS NOT NULL ORDER BY collected_at DESC LIMIT 1`).get(alert.target);
      isResolved = latest && latest.cpu_percent <= alertsConfig.cpuPercent;
    } else if (alert.alert_type === 'high_memory') {
      const latest = db.prepare(`SELECT memory_mb FROM container_snapshots WHERE container_name = ? AND memory_mb IS NOT NULL ORDER BY collected_at DESC LIMIT 1`).get(alert.target);
      isResolved = latest && latest.memory_mb <= alertsConfig.memoryMb;
    } else if (alert.alert_type === 'disk_full') {
      const latest = db.prepare(`SELECT used_percent FROM disk_snapshots WHERE mount_point = ? ORDER BY collected_at DESC LIMIT 1`).get(alert.target);
      isResolved = latest && latest.used_percent <= alertsConfig.diskPercent;
    }

    if (isResolved) {
      resolved.push({
        type: alert.alert_type,
        target: alert.target,
        message: getResolutionMessage(alert.alert_type, alert.target),
        triggeredAt: alert.triggered_at,
        isResolution: true,
      });
    }
  }

  return resolved;
}

function getResolutionMessage(type, target) {
  switch (type) {
    case 'container_down': return `Container "${target}" is running again`;
    case 'restart_loop': return `Container "${target}" restart loop resolved`;
    case 'high_cpu': return `Container "${target}" CPU back to normal`;
    case 'high_memory': return `Container "${target}" memory back to normal`;
    case 'disk_full': return `Disk "${target}" usage back to normal`;
    default: return `Alert resolved for ${target}`;
  }
}

/**
 * Process alerts: handle cooldown, deduplication, and DB state.
 * Returns array of alerts to send.
 */
function processAlerts(db, config, { triggered, resolved }) {
  const toSend = [];
  const cooldownMinutes = config.alerts.cooldownMinutes;

  // Process triggered alerts
  for (const alert of triggered) {
    const active = db.prepare(`
      SELECT id, last_notified, notify_count FROM alert_state
      WHERE alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.type, alert.target);

    if (!active) {
      // New alert
      db.prepare(`
        INSERT INTO alert_state (alert_type, target, triggered_at, last_notified, notify_count)
        VALUES (?, ?, datetime('now'), datetime('now'), 1)
      `).run(alert.type, alert.target);

      toSend.push({ ...alert, reminderNumber: 0 });
    } else {
      // Check cooldown
      const minutesSinceLast = db.prepare(`
        SELECT (julianday('now') - julianday(?)) * 1440 as minutes
      `).get(active.last_notified).minutes;

      if (minutesSinceLast >= cooldownMinutes) {
        const newCount = active.notify_count + 1;
        db.prepare(`
          UPDATE alert_state SET last_notified = datetime('now'), notify_count = ?
          WHERE id = ?
        `).run(newCount, active.id);

        toSend.push({ ...alert, reminderNumber: newCount - 1 });
      }
      // else: within cooldown, skip
    }
  }

  // Process resolutions
  for (const alert of resolved) {
    db.prepare(`
      UPDATE alert_state SET resolved_at = datetime('now')
      WHERE alert_type = ? AND target = ? AND resolved_at IS NULL
    `).run(alert.type, alert.target);

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
