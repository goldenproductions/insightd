const { SCHEMA_VERSION } = require('../db/schema');

const startTime = Date.now();

function getHealth(db) {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: '1.0.0',
    schemaVersion: SCHEMA_VERSION,
  };
}

function getHosts(db, onlineThresholdMinutes) {
  return db.prepare(`
    SELECT host_id, first_seen, last_seen,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts ORDER BY host_id
  `).all(onlineThresholdMinutes);
}

function getHostDetail(db, hostId, onlineThresholdMinutes) {
  const host = db.prepare(`
    SELECT host_id, first_seen, last_seen,
      CASE WHEN datetime(last_seen, '+' || ? || ' minutes') > datetime('now')
        THEN 1 ELSE 0 END as is_online
    FROM hosts WHERE host_id = ?
  `).get(onlineThresholdMinutes, hostId);

  if (!host) return null;

  return {
    ...host,
    containers: getLatestContainers(db, hostId),
    disk: getLatestDisk(db, hostId),
    alerts: getAlerts(db, true, hostId),
    updates: getLatestUpdates(db, hostId),
    hostMetrics: getLatestHostMetrics(db, hostId),
  };
}

function getLatestContainers(db, hostId) {
  return db.prepare(`
    SELECT cs.container_name, cs.container_id, cs.status,
           cs.cpu_percent, cs.memory_mb, cs.restart_count,
           cs.network_rx_bytes, cs.network_tx_bytes, cs.blkio_read_bytes, cs.blkio_write_bytes,
           cs.health_status, cs.collected_at
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id, container_name, MAX(collected_at) as max_at
      FROM container_snapshots WHERE host_id = ?
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.host_id
      AND cs.container_name = latest.container_name
      AND cs.collected_at = latest.max_at
    ORDER BY cs.container_name
  `).all(hostId);
}

function getLatestDisk(db, hostId) {
  return db.prepare(`
    SELECT mount_point, total_gb, used_gb, used_percent, collected_at
    FROM disk_snapshots
    WHERE host_id = ? AND collected_at = (
      SELECT MAX(collected_at) FROM disk_snapshots WHERE host_id = ?
    )
    ORDER BY mount_point
  `).all(hostId, hostId);
}

function getLatestUpdates(db, hostId) {
  return db.prepare(`
    SELECT container_name, image, has_update, checked_at
    FROM update_checks
    WHERE host_id = ? AND checked_at = (
      SELECT MAX(checked_at) FROM update_checks WHERE host_id = ?
    ) AND has_update = 1
    ORDER BY container_name
  `).all(hostId, hostId);
}

function getAlerts(db, activeOnly, hostId) {
  let sql = `
    SELECT id, host_id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count
    FROM alert_state
  `;
  const conditions = [];
  const params = [];

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

  return db.prepare(sql).all(...params);
}

function getDashboard(db, onlineThresholdMinutes) {
  const hosts = getHosts(db, onlineThresholdMinutes);

  const containerCounts = db.prepare(`
    SELECT
      SUM(1) as total,
      SUM(CASE WHEN cs.status = 'running' THEN 1 ELSE 0 END) as running
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots
      GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h
      AND cs.container_name = latest.cn
      AND cs.collected_at = latest.max_at
  `).get();

  const activeAlerts = db.prepare(
    'SELECT COUNT(*) as count FROM alert_state WHERE resolved_at IS NULL'
  ).get();

  const diskWarnings = db.prepare(`
    SELECT COUNT(*) as count FROM disk_snapshots ds
    INNER JOIN (
      SELECT host_id as h, mount_point as mp, MAX(collected_at) as max_at
      FROM disk_snapshots GROUP BY host_id, mount_point
    ) latest ON ds.host_id = latest.h
      AND ds.mount_point = latest.mp
      AND ds.collected_at = latest.max_at
    WHERE ds.used_percent >= 85
  `).get();

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
  `).get();

  return {
    hostCount: hosts.length,
    hostsOnline: hosts.filter(h => h.is_online).length,
    hostsOffline: hosts.filter(h => !h.is_online).length,
    totalContainers: containerCounts?.total || 0,
    containersRunning: containerCounts?.running || 0,
    containersDown: (containerCounts?.total || 0) - (containerCounts?.running || 0),
    activeAlerts: activeAlerts?.count || 0,
    diskWarnings: diskWarnings?.count || 0,
    updatesAvailable: updatesAvailable?.count || 0,
  };
}

function getLatestHostMetrics(db, hostId) {
  return db.prepare(`
    SELECT cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb,
           swap_total_mb, swap_used_mb, load_1, load_5, load_15, uptime_seconds, collected_at
    FROM host_snapshots WHERE host_id = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId) || null;
}

function getHostMetricsHistory(db, hostId, hours) {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb,
           load_1, load_5, load_15, collected_at
    FROM host_snapshots WHERE host_id = ? AND collected_at >= ${cutoff}
    ORDER BY collected_at ASC
  `).all(hostId);
}

function getContainerHistory(db, hostId, containerName, hours) {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT status, cpu_percent, memory_mb, restart_count,
           network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes,
           health_status, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
      AND collected_at >= ${cutoff}
    ORDER BY collected_at ASC
  `).all(hostId, containerName);
}

function getContainerAlerts(db, hostId, containerName) {
  return db.prepare(`
    SELECT id, alert_type, target, triggered_at, resolved_at, last_notified, notify_count
    FROM alert_state
    WHERE host_id = ? AND target = ?
    ORDER BY triggered_at DESC
  `).all(hostId, containerName);
}

module.exports = { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestDisk, getLatestUpdates, getAlerts, getDashboard, getContainerHistory, getContainerAlerts, getLatestHostMetrics, getHostMetricsHistory };
