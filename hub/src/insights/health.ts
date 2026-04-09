import logger = require('../../../shared/utils/logger');
import type Database from 'better-sqlite3';

const { getTimePeriod, MIN_PERIOD_SAMPLES } = require('./baselines') as { getTimePeriod: (hour: number) => string; MIN_PERIOD_SAMPLES: number };

interface BaselineRow {
  metric: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  sample_count: number;
}

interface HostIdRow {
  host_id: string;
}

interface HostSnapshotRow {
  cpu_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  load_5: number | null;
  [key: string]: any;
}

interface HostRow {
  host_id: string;
  last_seen: string;
  [key: string]: any;
}

interface AlertCountRow {
  c: number;
}

interface ContainerIdRow {
  host_id: string;
  container_name: string;
}

interface ContainerSnapshotRow {
  cpu_percent: number | null;
  memory_mb: number | null;
  health_status: string | null;
  [key: string]: any;
}

interface UptimeRow {
  total: number;
  running: number;
}

interface RestartRow {
  min_r: number | null;
  max_r: number | null;
}

interface HealthFactor {
  score: number;
  weight: number;
  value: number | string;
  baseline_p75?: number | null;
  rating: string;
}

/**
 * Score a metric value against its baseline percentiles.
 * Returns 0-100 where 100 = well within normal range.
 */
function scoreMetricVsBaseline(value: number | null | undefined, baseline: BaselineRow | undefined): number {
  if (value == null || !baseline || baseline.sample_count < 288) return 100; // cold start: assume healthy
  if (value <= (baseline.p75 ?? Infinity)) return 100;
  if (value <= (baseline.p90 ?? Infinity)) return 80;
  if (value <= (baseline.p95 ?? Infinity)) return 50;
  if (value <= (baseline.p99 ?? Infinity)) return 20;
  return 0;
}

function rateValue(value: number | null | undefined, baseline: BaselineRow | undefined): string {
  if (value == null || !baseline || baseline.sample_count < 288) return 'normal';
  if (value <= (baseline.p75 ?? Infinity)) return 'normal';
  if (value <= (baseline.p90 ?? Infinity)) return 'elevated';
  if (value <= (baseline.p95 ?? Infinity)) return 'high';
  return 'critical';
}

type BaselineCache = Map<string, Record<string, BaselineRow>>;

/**
 * Compute and store health scores for all hosts and containers.
 * Accepts optional baseline cache from computeBaselines to avoid re-querying.
 */
function computeHealthScores(db: Database.Database, baselineCache?: BaselineCache | null): void {
  const upsert = db.prepare(`
    INSERT INTO health_scores (entity_type, entity_id, score, factors, computed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      score=excluded.score, factors=excluded.factors, computed_at=excluded.computed_at
  `);

  let count = 0;
  const hostScores: number[] = [];

  // --- Host health scores ---
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all() as HostIdRow[];

  for (const { host_id } of hosts) {
    const latest = db.prepare('SELECT * FROM host_snapshots WHERE host_id = ? ORDER BY collected_at DESC LIMIT 1').get(host_id) as HostSnapshotRow | undefined;
    const host = db.prepare('SELECT * FROM hosts WHERE host_id = ?').get(host_id) as HostRow | undefined;
    const activeAlerts = db.prepare("SELECT COUNT(*) as c FROM alert_state WHERE host_id = ? AND resolved_at IS NULL").get(host_id) as AlertCountRow | undefined;
    const baselines = baselineCache?.get(`host:${host_id}`) as Record<string, BaselineRow> ?? getEntityBaselines(db, 'host', host_id);

    const factors: Record<string, HealthFactor> = {};
    let totalScore = 0;
    let totalWeight = 0;

    // CPU — only degrade when actually saturated. A server at 20% CPU is healthy.
    if (latest?.cpu_percent != null) {
      let score: number;
      let rating: string;
      if (latest.cpu_percent < 70)      { score = 100; rating = 'normal'; }
      else if (latest.cpu_percent < 85) { score = 70;  rating = 'elevated'; }
      else if (latest.cpu_percent < 95) { score = 40;  rating = 'high'; }
      else                              { score = 10;  rating = 'critical'; }
      factors.cpu = { score, weight: 20, value: round(latest.cpu_percent), rating };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Memory — only degrade when actually constrained (approaching capacity).
    // Memory usage by itself isn't bad; it only matters when you're running out.
    if (latest?.memory_used_mb != null && latest.memory_total_mb) {
      const memPct = (latest.memory_used_mb / latest.memory_total_mb) * 100;
      let score: number;
      let rating: string;
      if (memPct < 80)      { score = 100; rating = 'normal'; }
      else if (memPct < 90) { score = 70;  rating = 'elevated'; }
      else if (memPct < 95) { score = 40;  rating = 'high'; }
      else                  { score = 10;  rating = 'critical'; }
      factors.memory = { score, weight: 20, value: round(memPct), rating };
      totalScore += score * 20;
      totalWeight += 20;
    }

    // Load — capacity-based. Load under 4 is fine for typical homelab servers.
    if (latest?.load_5 != null) {
      let score: number;
      let rating: string;
      if (latest.load_5 < 4)       { score = 100; rating = 'normal'; }
      else if (latest.load_5 < 8)  { score = 70;  rating = 'elevated'; }
      else if (latest.load_5 < 16) { score = 40;  rating = 'high'; }
      else                         { score = 10;  rating = 'critical'; }
      factors.load = { score, weight: 15, value: round(latest.load_5), rating };
      totalScore += score * 15;
      totalWeight += 15;
    }

    // Online status (weight 20)
    const isOnline = host != null && (Date.now() - new Date(host.last_seen + 'Z').getTime()) < 10 * 60 * 1000;
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
  `).all() as ContainerIdRow[];

  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    const latest = db.prepare(`
      SELECT * FROM container_snapshots
      WHERE host_id = ? AND container_name = ? ORDER BY collected_at DESC LIMIT 1
    `).get(host_id, container_name) as ContainerSnapshotRow | undefined;

    const baselines = baselineCache?.get(`container:${entityId}`) as Record<string, BaselineRow> ?? getEntityBaselines(db, 'container', entityId);

    // Uptime in last 24h
    const uptimeData = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name) as UptimeRow;
    const uptimePct = uptimeData.total > 0 ? (uptimeData.running / uptimeData.total) * 100 : 100;

    // Restart delta in 24h
    const restartData = db.prepare(`
      SELECT MIN(restart_count) as min_r, MAX(restart_count) as max_r
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name) as RestartRow | undefined;
    const restarts = Math.max(0, (restartData?.max_r || 0) - (restartData?.min_r || 0));

    const factors: Record<string, HealthFactor> = {};
    let totalScore = 0;
    let totalWeight = 0;

    // CPU (weight 15) — baseline comparison but require meaningful absolute value.
    // Container CPU <50% should never degrade the score regardless of baseline.
    if (latest?.cpu_percent != null) {
      const bl = baselines.cpu_percent;
      let score = scoreMetricVsBaseline(latest.cpu_percent, bl);
      let rating = rateValue(latest.cpu_percent, bl);
      if (latest.cpu_percent < 50) { score = 100; rating = 'normal'; }
      else if (latest.cpu_percent < 80) { score = Math.max(score, 70); if (rating === 'critical' || rating === 'high') rating = 'elevated'; }
      factors.cpu = { score, weight: 15, value: round(latest.cpu_percent), baseline_p75: bl?.p75 ?? null, rating };
      totalScore += score * 15;
      totalWeight += 15;
    }

    // Memory (weight 10) — lower weight since we can't know the container's memory limit.
    // Only degrade when the deviation from baseline is substantial (>50 MB above P75).
    if (latest?.memory_mb != null) {
      const bl = baselines.memory_mb;
      let score = scoreMetricVsBaseline(latest.memory_mb, bl);
      let rating = rateValue(latest.memory_mb, bl);
      const deviation = bl?.p75 != null ? latest.memory_mb - bl.p75 : 0;
      if (deviation < 50) { score = 100; rating = 'normal'; }
      factors.memory = { score, weight: 10, value: round(latest.memory_mb), baseline_p75: bl?.p75 ?? null, rating };
      totalScore += score * 10;
      totalWeight += 10;
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

function getEntityBaselines(db: Database.Database, entityType: string, entityId: string): Record<string, BaselineRow> {
  const hour = new Date().getUTCHours();
  const period = getTimePeriod(hour);

  const allRows = db.prepare(
    "SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = 'all'"
  ).all(entityType, entityId) as BaselineRow[];
  const periodRows = db.prepare(
    'SELECT metric, p50, p75, p90, p95, p99, sample_count FROM baselines WHERE entity_type = ? AND entity_id = ? AND time_bucket = ?'
  ).all(entityType, entityId, period) as BaselineRow[];

  const map: Record<string, BaselineRow> = {};
  for (const r of allRows) map[r.metric] = r;
  for (const r of periodRows) {
    if (r.sample_count >= MIN_PERIOD_SAMPLES) map[r.metric] = r;
  }
  return map;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

module.exports = { computeHealthScores, scoreMetricVsBaseline, rateValue };
