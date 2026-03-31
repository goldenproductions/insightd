const logger = require('../../../shared/utils/logger');

/**
 * Score a metric value against its baseline percentiles.
 * Returns 0-100 where 100 = well within normal range.
 */
function scoreMetricVsBaseline(value, baseline) {
  if (value == null || !baseline || baseline.sample_count < 288) return 100; // cold start: assume healthy
  if (value <= baseline.p75) return 100;
  if (value <= baseline.p90) return 80;
  if (value <= baseline.p95) return 50;
  if (value <= baseline.p99) return 20;
  return 0;
}

function rateValue(value, baseline) {
  if (value == null || !baseline || baseline.sample_count < 288) return 'normal';
  if (value <= baseline.p75) return 'normal';
  if (value <= baseline.p90) return 'elevated';
  if (value <= baseline.p95) return 'high';
  return 'critical';
}

/**
 * Compute and store health scores for all hosts and containers.
 */
function computeHealthScores(db) {
  const upsert = db.prepare(`
    INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      score=excluded.score, factors=excluded.factors, computed_at=excluded.computed_at
  `);

  let count = 0;
  const hostScores = [];

  // --- Host health scores ---
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all();

  for (const { host_id } of hosts) {
    const latest = db.prepare('SELECT * FROM host_snapshots WHERE host_id = ? ORDER BY collected_at DESC LIMIT 1').get(host_id);
    const host = db.prepare('SELECT * FROM hosts WHERE host_id = ?').get(host_id);
    const activeAlerts = db.prepare("SELECT COUNT(*) as c FROM alert_state WHERE host_id = ? AND resolved_at IS NULL").get(host_id);
    const baselines = getEntityBaselines(db, 'host', host_id);

    const factors = {};
    let totalScore = 0;
    let totalWeight = 0;

    // CPU vs baseline (weight 20)
    if (latest?.cpu_percent != null) {
      const bl = baselines.cpu_percent;
      const score = scoreMetricVsBaseline(latest.cpu_percent, bl);
      factors.cpu = { score, weight: 20, value: latest.cpu_percent, baseline_p75: bl?.p75 ?? null, rating: rateValue(latest.cpu_percent, bl) };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Memory vs baseline (weight 20)
    if (latest?.memory_used_mb != null) {
      const bl = baselines.memory_used_mb;
      const score = scoreMetricVsBaseline(latest.memory_used_mb, bl);
      factors.memory = { score, weight: 20, value: latest.memory_used_mb, baseline_p75: bl?.p75 ?? null, rating: rateValue(latest.memory_used_mb, bl) };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Load vs baseline (weight 15)
    if (latest?.load_5 != null) {
      const bl = baselines.load_5;
      const score = scoreMetricVsBaseline(latest.load_5, bl);
      factors.load = { score, weight: 15, value: latest.load_5, baseline_p75: bl?.p75 ?? null, rating: rateValue(latest.load_5, bl) };
      totalScore += score * 15;
      totalWeight += 15;
    }

    // Online status (weight 20)
    const isOnline = host && (Date.now() - new Date(host.last_seen + 'Z').getTime()) < 10 * 60 * 1000;
    factors.online = { score: isOnline ? 100 : 0, weight: 20, value: isOnline ? 1 : 0, rating: isOnline ? 'normal' : 'critical' };
    totalScore += (isOnline ? 100 : 0) * 20;
    totalWeight += 20;

    // Active alerts (weight 15)
    const alertCount = activeAlerts?.c || 0;
    const alertScore = Math.max(0, 100 - alertCount * 20);
    factors.alerts = { score: alertScore, weight: 15, value: alertCount, rating: alertCount === 0 ? 'normal' : alertCount <= 2 ? 'elevated' : 'critical' };
    totalScore += alertScore * 15;
    totalWeight += 15;

    const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 100;
    upsert.run('host', host_id, finalScore, JSON.stringify(factors));
    hostScores.push(finalScore);
    count++;
  }

  // --- Container health scores ---
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-1 day')
  `).all();

  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    const latest = db.prepare(`
      SELECT * FROM container_snapshots
      WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(host_id, container_name);

    const baselines = getEntityBaselines(db, 'container', entityId);

    // Uptime in last 24h
    const uptimeData = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name);
    const uptimePct = uptimeData.total > 0 ? (uptimeData.running / uptimeData.total) * 100 : 100;

    // Restart delta in 24h
    const restartData = db.prepare(`
      SELECT MIN(restart_count) as min_r, MAX(restart_count) as max_r
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name);
    const restarts = Math.max(0, (restartData?.max_r || 0) - (restartData?.min_r || 0));

    const factors = {};
    let totalScore = 0;
    let totalWeight = 0;

    // CPU (weight 20)
    if (latest?.cpu_percent != null) {
      const bl = baselines.cpu_percent;
      const score = scoreMetricVsBaseline(latest.cpu_percent, bl);
      factors.cpu = { score, weight: 20, value: latest.cpu_percent, baseline_p75: bl?.p75 ?? null, rating: rateValue(latest.cpu_percent, bl) };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Memory (weight 20)
    if (latest?.memory_mb != null) {
      const bl = baselines.memory_mb;
      const score = scoreMetricVsBaseline(latest.memory_mb, bl);
      factors.memory = { score, weight: 20, value: latest.memory_mb, baseline_p75: bl?.p75 ?? null, rating: rateValue(latest.memory_mb, bl) };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Uptime (weight 25)
    const uptimeScore = Math.round(uptimePct);
    factors.uptime = { score: uptimeScore, weight: 25, value: uptimePct, rating: uptimePct >= 99 ? 'normal' : uptimePct >= 90 ? 'elevated' : 'critical' };
    totalScore += uptimeScore * 25;
    totalWeight += 25;

    // Restarts (weight 15)
    const restartScore = Math.max(0, 100 - restarts * 25);
    factors.restarts = { score: restartScore, weight: 15, value: restarts, rating: restarts === 0 ? 'normal' : restarts <= 2 ? 'elevated' : 'critical' };
    totalScore += restartScore * 15;
    totalWeight += 15;

    // Health check (weight 10)
    const healthStatus = latest?.health_status;
    const healthScore = !healthStatus || healthStatus === 'healthy' ? 100 : healthStatus === 'starting' ? 50 : 0;
    factors.health = { score: healthScore, weight: 10, value: healthStatus || 'none', rating: healthScore === 100 ? 'normal' : healthScore === 50 ? 'elevated' : 'critical' };
    totalScore += healthScore * 10;
    totalWeight += 10;

    const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 100;
    upsert.run('container', entityId, finalScore, JSON.stringify(factors));
    count++;
  }

  // --- System health score ---
  const systemScore = hostScores.length > 0 ? Math.round(hostScores.reduce((a, b) => a + b, 0) / hostScores.length) : 100;
  upsert.run('system', 'system', systemScore, JSON.stringify({ hostCount: hostScores.length, hostScores }));
  count++;

  if (count > 0) {
    logger.info('health', `Computed ${count} health scores (system: ${systemScore})`);
  }
}

function getEntityBaselines(db, entityType, entityId) {
  const rows = db.prepare(
    "SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = 'all'"
  ).all(entityType, entityId);
  const map = {};
  for (const r of rows) map[r.metric] = r;
  return map;
}

module.exports = { computeHealthScores, scoreMetricVsBaseline, rateValue };
