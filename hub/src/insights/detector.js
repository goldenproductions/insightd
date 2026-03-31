const logger = require('../../../shared/utils/logger');

/**
 * Generate insights by analyzing metrics against baselines.
 * Clears and regenerates the insights table each run.
 */
function generateInsights(db) {
  // Clear old insights
  db.prepare('DELETE FROM insights').run();

  const insert = db.prepare(`
    INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;

  // --- Host insights ---
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all();

  for (const { host_id } of hosts) {
    const baselines = getBaselines(db, 'host', host_id);

    // Sustained elevation: last 6 snapshots (30 min) all above P95
    const recent = db.prepare(
      'SELECT cpu_percent, memory_used_mb, load_5 FROM host_snapshots WHERE host_id = ? ORDER BY collected_at DESC LIMIT 6'
    ).all(host_id);

    if (recent.length >= 6) {
      for (const [metric, label, unit] of [['cpu_percent', 'CPU', '%'], ['memory_used_mb', 'Memory', ' MB'], ['load_5', 'Load', '']]) {
        const bl = baselines[metric];
        if (!bl || bl.sample_count < 288) continue;
        const values = recent.map(r => r[metric]).filter(v => v != null);
        if (values.length >= 6 && values.every(v => v > bl.p95)) {
          insert.run('host', host_id, 'performance', 'warning',
            `${label} elevated on ${host_id}`,
            `${label} has been above P95 (${round(bl.p95)}${unit}) for 30+ minutes. Current: ${round(values[0])}${unit}`,
            metric, values[0], bl.p95);
          count++;
        }
      }
    }

    // Week-over-week change
    const thisWeekAvg = db.prepare(`
      SELECT AVG(cpu_percent) as cpu, AVG(memory_used_mb) as mem
      FROM host_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-7 days')
    `).get(host_id);
    const lastWeekAvg = db.prepare(`
      SELECT AVG(cpu_percent) as cpu, AVG(memory_used_mb) as mem
      FROM host_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-14 days') AND collected_at < datetime('now', '-7 days')
    `).get(host_id);

    if (thisWeekAvg && lastWeekAvg) {
      if (lastWeekAvg.cpu > 0 && thisWeekAvg.cpu > lastWeekAvg.cpu * 2) {
        const ratio = round(thisWeekAvg.cpu / lastWeekAvg.cpu);
        insert.run('host', host_id, 'trend', 'warning',
          `CPU usage growing on ${host_id}`,
          `Average CPU is ${ratio}x higher than last week (${round(thisWeekAvg.cpu)}% vs ${round(lastWeekAvg.cpu)}%)`,
          'cpu_percent', thisWeekAvg.cpu, lastWeekAvg.cpu);
        count++;
      }
      if (lastWeekAvg.mem > 0 && thisWeekAvg.mem > lastWeekAvg.mem * 1.5) {
        const ratio = round(thisWeekAvg.mem / lastWeekAvg.mem);
        insert.run('host', host_id, 'trend', 'info',
          `Memory usage growing on ${host_id}`,
          `Average memory is ${ratio}x higher than last week (${round(thisWeekAvg.mem)} MB vs ${round(lastWeekAvg.mem)} MB)`,
          'memory_used_mb', thisWeekAvg.mem, lastWeekAvg.mem);
        count++;
      }
    }
  }

  // --- Container insights ---
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-1 day')
  `).all();

  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    const baselines = getBaselines(db, 'container', entityId);

    // Sustained elevation
    const recent = db.prepare(`
      SELECT cpu_percent, memory_mb FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND status = 'running'
      ORDER BY collected_at DESC LIMIT 6
    `).all(host_id, container_name);

    if (recent.length >= 6) {
      for (const [metric, label, unit] of [['cpu_percent', 'CPU', '%'], ['memory_mb', 'Memory', ' MB']]) {
        const bl = baselines[metric];
        if (!bl || bl.sample_count < 288) continue;
        const values = recent.map(r => r[metric]).filter(v => v != null);
        if (values.length >= 6 && values.every(v => v > bl.p95)) {
          insert.run('container', entityId, 'performance', 'warning',
            `${container_name} ${label.toLowerCase()} elevated`,
            `${container_name} ${label.toLowerCase()} has been above P95 (${round(bl.p95)}${unit}) for 30+ minutes. Current: ${round(values[0])}${unit}`,
            metric, values[0], bl.p95);
          count++;
        }
      }
    }

    // Availability
    const uptimeData = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name);

    if (uptimeData.total > 0) {
      const uptimePct = (uptimeData.running / uptimeData.total) * 100;
      if (uptimePct < 99 && uptimePct > 0) {
        const downMinutes = Math.round((uptimeData.total - uptimeData.running) * 5);
        insert.run('container', entityId, 'availability', uptimePct < 90 ? 'critical' : 'warning',
          `${container_name} had downtime`,
          `${container_name} was down for ~${downMinutes} minutes in the last 24 hours (${round(uptimePct)}% uptime)`,
          null, uptimePct, 99);
        count++;
      }
    }

    // Restart anomaly
    const restartData = db.prepare(`
      SELECT MIN(restart_count) as min_r, MAX(restart_count) as max_r
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name);
    const restarts = Math.max(0, (restartData?.max_r || 0) - (restartData?.min_r || 0));
    if (restarts >= 3) {
      insert.run('container', entityId, 'availability', 'warning',
        `${container_name} restarting frequently`,
        `${container_name} has restarted ${restarts} times in the last 24 hours`,
        null, restarts, 0);
      count++;
    }

    // Week-over-week memory growth
    const thisWeek = db.prepare(`
      SELECT AVG(memory_mb) as mem FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND status = 'running' AND collected_at >= datetime('now', '-7 days')
    `).get(host_id, container_name);
    const lastWeek = db.prepare(`
      SELECT AVG(memory_mb) as mem FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND status = 'running'
        AND collected_at >= datetime('now', '-14 days') AND collected_at < datetime('now', '-7 days')
    `).get(host_id, container_name);

    if (thisWeek?.mem && lastWeek?.mem && lastWeek.mem > 0 && thisWeek.mem > lastWeek.mem * 2) {
      const ratio = round(thisWeek.mem / lastWeek.mem);
      insert.run('container', entityId, 'trend', 'warning',
        `${container_name} memory growing`,
        `${container_name} is using ${ratio}x more memory than last week (${round(thisWeek.mem)} MB vs ${round(lastWeek.mem)} MB)`,
        'memory_mb', thisWeek.mem, lastWeek.mem);
      count++;
    }
  }

  if (count > 0) {
    logger.info('insights', `Generated ${count} insights`);
  }
}

function getBaselines(db, entityType, entityId) {
  const rows = db.prepare(
    "SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = 'all'"
  ).all(entityType, entityId);
  const map = {};
  for (const r of rows) map[r.metric] = r;
  return map;
}

function round(v) {
  return Math.round(v * 10) / 10;
}

module.exports = { generateInsights };
