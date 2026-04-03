const logger = require('../../../shared/utils/logger');
const { getTimePeriod, MIN_PERIOD_SAMPLES } = require('./baselines');

/**
 * Generate insights by analyzing metrics against baselines.
 * Clears and regenerates the insights table each run.
 */
function generateInsights(db) {
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
        const spread = (bl.p95 - (bl.p50 || 0));
        if (spread < (bl.p50 || 1) * 0.1) continue;
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
        const spread = (bl.p95 - (bl.p50 || 0));
        if (spread < (bl.p50 || 1) * 0.1) continue;
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

  // --- Predictive alerts ---
  count += generatePredictions(db, insert);

  // --- Correlation enrichment ---
  enrichInsightsWithCorrelations(db);

  if (count > 0) {
    logger.info('insights', `Generated ${count} insights`);
  }
}

/**
 * Generate predictive insights based on 7-day metric trends.
 * Pattern: same linear regression as disk forecast.
 */
function generatePredictions(db, insert) {
  let count = 0;

  // Host predictions
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all();
  for (const { host_id } of hosts) {
    for (const [metric, label, unit, table] of [
      ['cpu_percent', 'CPU', '%', 'host_snapshots'],
      ['memory_used_mb', 'Memory', ' MB', 'host_snapshots'],
      ['load_5', 'Load', '', 'host_snapshots'],
    ]) {
      const pred = computeMetricTrend(db, table, 'host_id', host_id, metric, null);
      if (!pred) continue;
      const bl = db.prepare(
        "SELECT p90 FROM baselines WHERE entity_type = 'host' AND entity_id = ? AND metric = ? AND time_bucket = 'all'"
      ).get(host_id, metric);
      if (!bl || bl.p90 == null) continue;
      if (pred.current >= bl.p90) continue; // already above threshold
      if (pred.dailyGrowth <= 0) continue;
      const remaining = bl.p90 - pred.current;
      const daysUntil = Math.round(remaining / pred.dailyGrowth);
      if (daysUntil > 14 || daysUntil <= 0) continue;
      const severity = daysUntil <= 7 ? 'critical' : 'warning';
      insert.run('host', host_id, 'prediction', severity,
        `${label} trending up on ${host_id}`,
        `${label} growing ${round(pred.dailyGrowth)}${unit}/day — will exceed normal range (P90: ${round(bl.p90)}${unit}) in ~${daysUntil} days`,
        metric, pred.current, bl.p90);
      count++;
    }
  }

  // Container predictions
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-7 days') AND status = 'running'
  `).all();
  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    for (const [metric, label, unit] of [['cpu_percent', 'CPU', '%'], ['memory_mb', 'Memory', ' MB']]) {
      const pred = computeMetricTrend(db, 'container_snapshots', 'host_id', host_id, metric, container_name);
      if (!pred) continue;
      const bl = db.prepare(
        "SELECT p90 FROM baselines WHERE entity_type = 'container' AND entity_id = ? AND metric = ? AND time_bucket = 'all'"
      ).get(entityId, metric);
      if (!bl || bl.p90 == null) continue;
      if (pred.current >= bl.p90) continue;
      if (pred.dailyGrowth <= 0) continue;
      const remaining = bl.p90 - pred.current;
      const daysUntil = Math.round(remaining / pred.dailyGrowth);
      if (daysUntil > 14 || daysUntil <= 0) continue;
      const severity = daysUntil <= 7 ? 'critical' : 'warning';
      insert.run('container', entityId, 'prediction', severity,
        `${container_name} ${label.toLowerCase()} trending up`,
        `${container_name} ${label.toLowerCase()} growing ${round(pred.dailyGrowth)}${unit}/day — will exceed normal range in ~${daysUntil} days`,
        metric, pred.current, bl.p90);
      count++;
    }
  }

  return count;
}

/**
 * Compute 7-day linear trend for a metric.
 * Returns { current, dailyGrowth } or null if insufficient data.
 */
function computeMetricTrend(db, table, hostCol, hostId, metric, containerName) {
  let query, params;
  if (containerName) {
    query = `SELECT AVG(${metric}) as avg_val, DATE(collected_at) as day
      FROM ${table} WHERE ${hostCol} = ? AND container_name = ? AND status = 'running'
        AND collected_at >= datetime('now', '-7 days')
      GROUP BY DATE(collected_at) ORDER BY day`;
    params = [hostId, containerName];
  } else {
    query = `SELECT AVG(${metric}) as avg_val, DATE(collected_at) as day
      FROM ${table} WHERE ${hostCol} = ?
        AND collected_at >= datetime('now', '-7 days')
      GROUP BY DATE(collected_at) ORDER BY day`;
    params = [hostId];
  }

  const dailyAvgs = db.prepare(query).all(...params).filter(r => r.avg_val != null);
  if (dailyAvgs.length < 3) return null;

  const first = dailyAvgs[0].avg_val;
  const last = dailyAvgs[dailyAvgs.length - 1].avg_val;
  const days = dailyAvgs.length - 1;
  if (days <= 0) return null;

  const dailyGrowth = (last - first) / days;
  // Skip if growth is less than 1% of current value per day
  if (last > 0 && Math.abs(dailyGrowth / last) < 0.01) return null;

  return { current: last, dailyGrowth };
}

/**
 * Enrich insights with correlation data.
 * 1. Cascade detection: collapse multiple container availability insights into host-level
 * 2. Temporal correlation: annotate insights with related events
 */
function enrichInsightsWithCorrelations(db) {
  let modified = 0;

  // --- Cascade detection ---
  const containerAvails = db.prepare(
    "SELECT id, entity_id, title, message FROM insights WHERE entity_type = 'container' AND category = 'availability'"
  ).all();

  const byHost = {};
  for (const ci of containerAvails) {
    const hostId = ci.entity_id.split('/')[0];
    if (!byHost[hostId]) byHost[hostId] = [];
    byHost[hostId].push(ci);
  }

  for (const [hostId, insights] of Object.entries(byHost)) {
    if (insights.length < 3) continue;
    const totalOnHost = db.prepare(
      "SELECT COUNT(DISTINCT container_name) as c FROM container_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-1 day')"
    ).get(hostId);
    if (insights.length >= totalOnHost.c * 0.5) {
      const names = insights.map(i => i.entity_id.split('/')[1]);
      const ids = insights.map(i => i.id);
      db.prepare(`DELETE FROM insights WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      db.prepare(`
        INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('host', hostId, 'availability', 'critical',
        `Host ${hostId} appears to have gone offline`,
        `${insights.length} containers affected: ${names.join(', ')}. Individual downtime is likely caused by host unavailability.`,
        null, insights.length, 0);
      modified++;
    }
  }

  // --- Temporal correlation ---
  const allInsights = db.prepare(
    "SELECT id, entity_type, entity_id, category, message FROM insights"
  ).all();

  for (const insight of allInsights) {
    if (insight.category === 'availability') continue;

    const hostId = insight.entity_type === 'host'
      ? insight.entity_id
      : insight.entity_id.split('/')[0];

    const recentEvents = db.prepare(`
      SELECT cs1.container_name, cs1.status as new_status, cs2.status as old_status
      FROM container_snapshots cs1
      JOIN container_snapshots cs2 ON cs1.host_id = cs2.host_id
        AND cs1.container_name = cs2.container_name
        AND cs2.collected_at = (
          SELECT MAX(collected_at) FROM container_snapshots
          WHERE host_id = cs1.host_id AND container_name = cs1.container_name
            AND collected_at < cs1.collected_at
        )
      WHERE cs1.host_id = ? AND cs1.status != cs2.status
        AND cs1.collected_at >= datetime('now', '-1 hour')
      ORDER BY cs1.collected_at DESC
    `).all(hostId);

    const recentAlerts = db.prepare(`
      SELECT alert_type, target FROM alert_state
      WHERE host_id = ? AND triggered_at >= datetime('now', '-1 hour')
      ORDER BY triggered_at DESC
    `).all(hostId);

    const correlations = [];
    const selfContainer = insight.entity_type === 'container' ? insight.entity_id.split('/')[1] : null;

    for (const evt of recentEvents) {
      if (selfContainer && evt.container_name === selfContainer) continue;
      const action = evt.new_status === 'running' ? 'started' : 'stopped';
      correlations.push(`${evt.container_name} ${action}`);
    }
    for (const alert of recentAlerts) {
      if (selfContainer && alert.target === selfContainer) continue;
      correlations.push(`${alert.alert_type.replace(/_/g, ' ')} on ${alert.target}`);
    }

    if (correlations.length > 0) {
      const suffix = ` (may be related to: ${correlations.slice(0, 3).join(', ')}${correlations.length > 3 ? ` +${correlations.length - 3} more` : ''})`;
      db.prepare('UPDATE insights SET message = message || ? WHERE id = ?').run(suffix, insight.id);
      modified++;
    }
  }

  if (modified > 0) {
    logger.info('insights', `Enriched ${modified} insights with correlations`);
  }
}

/**
 * Get baselines for an entity, preferring the current time period.
 */
function getBaselines(db, entityType, entityId, hour) {
  if (hour == null) hour = new Date().getUTCHours();
  const period = getTimePeriod(hour);

  const allRows = db.prepare(
    "SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = 'all'"
  ).all(entityType, entityId);
  const periodRows = db.prepare(
    'SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = ?'
  ).all(entityType, entityId, period);

  const map = {};
  for (const r of allRows) map[r.metric] = r;
  for (const r of periodRows) {
    if (r.sample_count >= MIN_PERIOD_SAMPLES) map[r.metric] = r;
  }
  return map;
}

function round(v) {
  return Math.round(v * 10) / 10;
}

module.exports = { generateInsights, getBaselines };
