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
    diskForecast: getDiskForecast(db, hostId),
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

function getContainerId(db, hostId, containerName) {
  const row = db.prepare(`
    SELECT container_id FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId, containerName);
  return row?.container_id || null;
}

function getUptimeTimeline(db, hostId, days) {
  const rows = db.prepare(`
    SELECT container_name, status, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND collected_at >= datetime('now', '-' || ? || ' days')
    ORDER BY container_name, collected_at
  `).all(hostId, days);

  const containers = {};
  for (const r of rows) {
    if (!containers[r.container_name]) containers[r.container_name] = [];
    containers[r.container_name].push(r);
  }

  const totalHours = days * 24;
  const now = Date.now();
  const startMs = now - days * 86400000;

  return Object.entries(containers).map(([name, snapshots]) => {
    const slots = [];
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

function getResourceRankings(db, limit) {
  const query = `
    SELECT cs.host_id, cs.container_name, cs.cpu_percent, cs.memory_mb
    FROM container_snapshots cs
    INNER JOIN (
      SELECT host_id as h, container_name as cn, MAX(collected_at) as max_at
      FROM container_snapshots GROUP BY host_id, container_name
    ) latest ON cs.host_id = latest.h AND cs.container_name = latest.cn AND cs.collected_at = latest.max_at
    WHERE cs.status = 'running'
  `;
  const byCpu = db.prepare(query + ' AND cs.cpu_percent IS NOT NULL ORDER BY cs.cpu_percent DESC LIMIT ?').all(limit);
  const byMemory = db.prepare(query + ' AND cs.memory_mb IS NOT NULL ORDER BY cs.memory_mb DESC LIMIT ?').all(limit);
  return { byCpu, byMemory };
}

function getTrends(db, hostId) {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const twoWeeksAgo = new Date(now - 14 * 86400000);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
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
  `).all(thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, hostId, lastWeek, nowStr);

  const containers = containerTrends.map(r => {
    const cpuChange = r.last_cpu && r.this_cpu ? Math.round(((r.this_cpu - r.last_cpu) / r.last_cpu) * 100) : null;
    const memChange = r.last_mem && r.this_mem ? Math.round(((r.this_mem - r.last_mem) / r.last_mem) * 100) : null;
    return {
      name: r.container_name,
      cpuNow: r.this_cpu ? Math.round(r.this_cpu * 10) / 10 : null,
      cpuChange,
      memNow: r.this_mem ? Math.round(r.this_mem) : null,
      memChange,
      flagged: (cpuChange && Math.abs(cpuChange) > 10) || (memChange && Math.abs(memChange) > 10),
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
  `).get(thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, thisWeek, nowStr, lastWeek, thisWeek, hostId, lastWeek, nowStr);

  let host = null;
  if (hostTrend && hostTrend.this_cpu != null) {
    const pctChange = (curr, prev) => prev && curr ? Math.round(((curr - prev) / prev) * 100) : null;
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

function getEvents(db, hostId, days) {
  const events = [];

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
  `).all(hostId, days);

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
  `).all(hostId, days);

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

function getDiskForecast(db, hostId) {
  const mounts = db.prepare(`
    SELECT DISTINCT mount_point FROM disk_snapshots WHERE host_id = ?
  `).all(hostId);

  return mounts.map(({ mount_point }) => {
    const rows = db.prepare(`
      SELECT used_gb, total_gb, used_percent, collected_at
      FROM disk_snapshots
      WHERE host_id = ? AND mount_point = ?
        AND collected_at >= datetime('now', '-7 days')
      ORDER BY collected_at
    `).all(hostId, mount_point);

    if (rows.length < 2) return { mountPoint: mount_point, daysUntilFull: null, dailyGrowthGb: 0 };

    // Linear regression: slope of used_gb over time
    const first = rows[0];
    const last = rows[rows.length - 1];
    const timeSpanDays = (new Date(last.collected_at + 'Z') - new Date(first.collected_at + 'Z')) / 86400000;
    if (timeSpanDays < 0.1) return { mountPoint: mount_point, daysUntilFull: null, dailyGrowthGb: 0 };

    const dailyGrowthGb = (last.used_gb - first.used_gb) / timeSpanDays;
    const remainingGb = last.total_gb - last.used_gb;

    let daysUntilFull = null;
    if (dailyGrowthGb > 0.001) {
      daysUntilFull = Math.round(remainingGb / dailyGrowthGb);
    }

    return { mountPoint: mount_point, daysUntilFull, dailyGrowthGb: Math.round(dailyGrowthGb * 1000) / 1000, currentPercent: last.used_percent };
  });
}

module.exports = { getHealth, getHosts, getHostDetail, getLatestContainers, getLatestDisk, getLatestUpdates, getAlerts, getDashboard, getContainerHistory, getContainerAlerts, getLatestHostMetrics, getHostMetricsHistory, getContainerId, getUptimeTimeline, getResourceRankings, getTrends, getEvents, getDiskForecast };
