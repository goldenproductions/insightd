import logger = require('../../../shared/utils/logger');
import type Database from 'better-sqlite3';

const { getTimePeriod, MIN_PERIOD_SAMPLES } = require('./baselines') as { getTimePeriod: (hour: number) => string; MIN_PERIOD_SAMPLES: number };

interface HostIdRow {
  host_id: string;
}

interface ContainerIdRow {
  host_id: string;
  container_name: string;
}

interface HostSnapshotRow {
  cpu_percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  load_5: number | null;
  [key: string]: number | null | string | undefined;
}

interface ContainerSnapshotRow {
  cpu_percent: number | null;
  memory_mb: number | null;
  [key: string]: number | null | string | undefined;
}

interface WeekAvgRow {
  cpu: number | null;
  mem: number | null;
}

interface UptimeRow {
  total: number;
  running: number;
}

interface RestartRow {
  min_r: number | null;
  max_r: number | null;
}

interface ContainerWeekRow {
  mem: number | null;
}

interface BaselineRow {
  metric: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  sample_count: number;
}

interface DailyAvgRow {
  avg_val: number | null;
  day: string;
}

interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  title: string;
  message: string;
}

interface ContainerAvailRow {
  id: number;
  entity_id: string;
  title: string;
  message: string;
}

interface TotalOnHostRow {
  c: number;
}

interface StatusChangeRow {
  container_name: string;
  new_status: string;
  old_status: string;
}

interface AlertStateRow {
  alert_type: string;
  target: string;
}

type BaselineCache = Map<string, Record<string, BaselineRow>>;

/**
 * Generate insights by analyzing metrics against baselines.
 * Clears and regenerates the insights table each run.
 * Accepts optional baseline cache from computeBaselines to avoid re-querying.
 */
function generateInsights(db: Database.Database, baselineCache?: BaselineCache | null): void {
  db.prepare('DELETE FROM insights').run();

  const insert = db.prepare(`
    INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;

  // --- Host insights ---
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all() as HostIdRow[];

  for (const { host_id } of hosts) {
    const baselines = baselineCache?.get(`host:${host_id}`) as Record<string, BaselineRow> ?? getBaselines(db, 'host', host_id);

    // Sustained high utilization: last 6 snapshots (30 min) all above capacity thresholds.
    // Only flag when resources are actually constrained, not when above baseline.
    const recent = db.prepare(
      'SELECT cpu_percent, memory_used_mb, memory_total_mb, load_5 FROM host_snapshots WHERE host_id = ? ORDER BY collected_at DESC LIMIT 6'
    ).all(host_id) as HostSnapshotRow[];

    if (recent.length >= 6) {
      // CPU: only flag sustained >80%
      const cpuValues = recent.map(r => r.cpu_percent).filter((v): v is number => v != null);
      if (cpuValues.length >= 6 && cpuValues.every(v => v > 80)) {
        insert.run('host', host_id, 'performance', cpuValues[0] > 95 ? 'critical' : 'warning',
          `CPU saturated on ${host_id}`,
          `CPU has been above 80% for 30+ minutes. Current: ${round(cpuValues[0])}%`,
          'cpu_percent', cpuValues[0], 80);
        count++;
      }

      // Memory: only flag sustained >85% of total
      const memPcts = recent.map(r => {
        const used = r.memory_used_mb;
        const total = r.memory_total_mb;
        return used != null && total ? (used / total) * 100 : null;
      }).filter((v): v is number => v != null);
      if (memPcts.length >= 6 && memPcts.every(v => v > 85)) {
        insert.run('host', host_id, 'performance', memPcts[0] > 95 ? 'critical' : 'warning',
          `Memory pressure on ${host_id}`,
          `Memory has been above 85% for 30+ minutes. Current: ${round(memPcts[0])}%`,
          'memory_used_mb', memPcts[0], 85);
        count++;
      }

      // Load: only flag sustained >8
      const loadValues = recent.map(r => r.load_5).filter((v): v is number => v != null);
      if (loadValues.length >= 6 && loadValues.every(v => v > 8)) {
        insert.run('host', host_id, 'performance', loadValues[0] > 16 ? 'critical' : 'warning',
          `High load on ${host_id}`,
          `Load average has been above 8 for 30+ minutes. Current: ${round(loadValues[0])}`,
          'load_5', loadValues[0], 8);
        count++;
      }
    }

    // Week-over-week change — only flag when current utilization is already concerning.
    // A jump from 5% to 15% CPU is not a problem. A jump from 40% to 80% is.
    const thisWeekAvg = db.prepare(`
      SELECT AVG(cpu_percent) as cpu, AVG(memory_used_mb) as mem
      FROM host_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-7 days')
    `).get(host_id) as WeekAvgRow | undefined;
    const lastWeekAvg = db.prepare(`
      SELECT AVG(cpu_percent) as cpu, AVG(memory_used_mb) as mem
      FROM host_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-14 days') AND collected_at < datetime('now', '-7 days')
    `).get(host_id) as WeekAvgRow | undefined;

    if (thisWeekAvg && lastWeekAvg) {
      // CPU trend: only flag if current week avg is already above 40% AND doubled
      if (lastWeekAvg.cpu != null && lastWeekAvg.cpu > 0 && thisWeekAvg.cpu != null
          && thisWeekAvg.cpu > lastWeekAvg.cpu * 2
          && thisWeekAvg.cpu >= 40) {
        const ratio = round(thisWeekAvg.cpu / lastWeekAvg.cpu);
        insert.run('host', host_id, 'trend', 'warning',
          `CPU usage growing on ${host_id}`,
          `Average CPU is ${ratio}x higher than last week (${round(thisWeekAvg.cpu)}% vs ${round(lastWeekAvg.cpu)}%)`,
          'cpu_percent', thisWeekAvg.cpu, lastWeekAvg.cpu);
        count++;
      }
      // Memory trend: only flag if we know total and usage is above 50% of capacity AND grew 1.5x
      const memTotal = recent.length > 0 ? recent[0].memory_total_mb : null;
      const memPct = memTotal ? ((thisWeekAvg.mem ?? 0) / memTotal) * 100 : null;
      if (lastWeekAvg.mem != null && lastWeekAvg.mem > 0 && thisWeekAvg.mem != null
          && thisWeekAvg.mem > lastWeekAvg.mem * 1.5
          && memPct != null && memPct >= 50) {
        const ratio = round(thisWeekAvg.mem / lastWeekAvg.mem);
        insert.run('host', host_id, 'trend', 'warning',
          `Memory usage growing on ${host_id}`,
          `Average memory is ${ratio}x higher than last week (${round(memPct)}% of total)`,
          'memory_used_mb', thisWeekAvg.mem, lastWeekAvg.mem);
        count++;
      }
    }
  }

  // --- Container insights ---
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-1 day')
  `).all() as ContainerIdRow[];

  for (const { host_id, container_name } of containers) {
    // Skip insightd's own containers — not actionable
    if (isInsightdContainer(container_name)) continue;

    const entityId = `${host_id}/${container_name}`;
    const baselines = baselineCache?.get(`container:${entityId}`) as Record<string, BaselineRow> ?? getBaselines(db, 'container', entityId);

    // Sustained high usage — only flag when above capacity thresholds AND above baseline P95.
    // Container CPU >50% sustained OR memory >500 MB above P95 for 30+ minutes.
    const recent = db.prepare(`
      SELECT cpu_percent, memory_mb FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND status = 'running'
      ORDER BY collected_at DESC LIMIT 6
    `).all(host_id, container_name) as ContainerSnapshotRow[];

    if (recent.length >= 6) {
      // CPU: only flag sustained >50% AND above P95
      const cpuBl = baselines.cpu_percent;
      if (cpuBl && cpuBl.sample_count >= 288 && cpuBl.p95 != null) {
        const cpuValues = recent.map(r => r.cpu_percent).filter((v): v is number => v != null);
        if (cpuValues.length >= 6 && cpuValues.every(v => v > 50 && v > (cpuBl.p95 ?? 0))) {
          insert.run('container', entityId, 'performance', 'warning',
            `${container_name} CPU sustained high`,
            `${container_name} CPU has been above 50% for 30+ minutes. Current: ${round(cpuValues[0])}%`,
            'cpu_percent', cpuValues[0], cpuBl.p95);
          count++;
        }
      }

      // Memory: only flag sustained above P95 AND >500 MB above P95
      const memBl = baselines.memory_mb;
      if (memBl && memBl.sample_count >= 288 && memBl.p95 != null) {
        const memValues = recent.map(r => r.memory_mb).filter((v): v is number => v != null);
        const p95 = memBl.p95 ?? 0;
        if (memValues.length >= 6 && memValues.every(v => v > p95) && (memValues[0] - p95) >= 500) {
          insert.run('container', entityId, 'performance', 'warning',
            `${container_name} memory unusually high`,
            `${container_name} memory at ${round(memValues[0])} MB, sustained above P95 (${round(p95)} MB) for 30+ minutes`,
            'memory_mb', memValues[0], memBl.p95);
          count++;
        }
      }
    }

    // Availability
    const uptimeData = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM container_snapshots WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-1 day')
    `).get(host_id, container_name) as UptimeRow;

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
    `).get(host_id, container_name) as RestartRow | undefined;
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
    `).get(host_id, container_name) as ContainerWeekRow | undefined;
    const lastWeek = db.prepare(`
      SELECT AVG(memory_mb) as mem FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND status = 'running'
        AND collected_at >= datetime('now', '-14 days') AND collected_at < datetime('now', '-7 days')
    `).get(host_id, container_name) as ContainerWeekRow | undefined;

    if (thisWeek?.mem && lastWeek?.mem && lastWeek.mem > 0
        && thisWeek.mem > lastWeek.mem * 2
        && thisWeek.mem >= (MIN_TREND_VALUE.memory_mb ?? 0)) {
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
function generatePredictions(db: Database.Database, insert: Database.Statement): number {
  let count = 0;

  // Host predictions
  const hosts = db.prepare('SELECT DISTINCT host_id FROM hosts').all() as HostIdRow[];
  for (const { host_id } of hosts) {
    for (const [metric, label, unit, table] of [
      ['cpu_percent', 'CPU', '%', 'host_snapshots'],
      ['memory_used_mb', 'Memory', ' MB', 'host_snapshots'],
      ['load_5', 'Load', '', 'host_snapshots'],
    ] as const) {
      const pred = computeMetricTrend(db, table, 'host_id', host_id, metric, null);
      if (!pred) continue;
      const bl = db.prepare(
        "SELECT p50, p75, p90 FROM baselines WHERE entity_type = 'host' AND entity_id = ? AND metric = ? AND time_bucket = 'all'"
      ).get(host_id, metric) as { p50: number | null; p75: number | null; p90: number | null } | undefined;
      if (!bl || bl.p90 == null) continue;
      if (pred.current >= bl.p90) continue; // already above threshold
      if (pred.dailyGrowth <= 0) continue;
      // If the live value is below P75, the trend doesn't match reality — skip
      if (pred.liveValue != null && bl.p75 != null && pred.liveValue < bl.p75) continue;
      const remaining = bl.p90 - pred.current;
      const daysUntil = Math.round(remaining / pred.dailyGrowth);
      if (daysUntil > 14 || daysUntil <= 0) continue;
      // Predictions are inherently uncertain — only "critical" if live value also above P75
      const liveSupports = pred.liveValue != null && bl.p75 != null && pred.liveValue >= bl.p75;
      const severity = daysUntil <= 3 && liveSupports ? 'critical' : 'warning';
      const dayWord = daysUntil === 1 ? 'day' : 'days';
      insert.run('host', host_id, 'prediction', severity,
        `${label} trending up on ${host_id}`,
        `${label} at ${round(pred.current)}${unit}, growing ${round(pred.dailyGrowth)}${unit}/day — will exceed P90 (${round(bl.p90)}${unit}) in ~${daysUntil} ${dayWord}`,
        metric, pred.current, bl.p90);
      count++;
    }
  }

  // Container predictions
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-7 days') AND status = 'running'
  `).all() as ContainerIdRow[];
  for (const { host_id, container_name } of containers) {
    // Skip insightd internal containers — their minor memory growth is expected and not actionable
    if (isInsightdContainer(container_name)) continue;
    const entityId = `${host_id}/${container_name}`;
    for (const [metric, label, unit] of [['cpu_percent', 'CPU', '%'], ['memory_mb', 'Memory', ' MB']] as const) {
      const pred = computeMetricTrend(db, 'container_snapshots', 'host_id', host_id, metric, container_name);
      if (!pred) continue;
      const bl = db.prepare(
        "SELECT p50, p75, p90 FROM baselines WHERE entity_type = 'container' AND entity_id = ? AND metric = ? AND time_bucket = 'all'"
      ).get(entityId, metric) as { p50: number | null; p75: number | null; p90: number | null } | undefined;
      if (!bl || bl.p90 == null) continue;
      if (pred.current >= bl.p90) continue;
      if (pred.dailyGrowth <= 0) continue;
      // If the live value is below P75, the trend doesn't match reality — skip
      if (pred.liveValue != null && bl.p75 != null && pred.liveValue < bl.p75) continue;
      const remaining = bl.p90 - pred.current;
      const daysUntil = Math.round(remaining / pred.dailyGrowth);
      if (daysUntil > 14 || daysUntil <= 0) continue;
      const liveSupports = pred.liveValue != null && bl.p75 != null && pred.liveValue >= bl.p75;
      const severity = daysUntil <= 3 && liveSupports ? 'critical' : 'warning';
      const dayWord = daysUntil === 1 ? 'day' : 'days';
      insert.run('container', entityId, 'prediction', severity,
        `${container_name} ${label.toLowerCase()} trending up`,
        `${container_name} ${label.toLowerCase()} at ${round(pred.current)}${unit}, growing ${round(pred.dailyGrowth)}${unit}/day — will exceed P90 (${round(bl.p90)}${unit}) in ~${daysUntil} ${dayWord}`,
        metric, pred.current, bl.p90);
      count++;
    }
  }

  return count;
}

interface LatestSnapshotRow {
  val: number | null;
}

/**
 * Compute 7-day linear trend for a metric.
 * Returns { current, liveValue, dailyGrowth } or null if insufficient data.
 *
 * Validates trend consistency: requires majority of day-over-day changes to be
 * in the same direction as the overall trend (prevents single-spike false positives).
 * Also fetches the latest live snapshot value so callers can compare prediction
 * against what's actually happening right now.
 */
function computeMetricTrend(db: Database.Database, table: string, hostCol: string, hostId: string, metric: string, containerName: string | null): { current: number; liveValue: number | null; dailyGrowth: number } | null {
  let query: string;
  let params: string[];
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

  const dailyAvgs = (db.prepare(query).all(...params) as DailyAvgRow[]).filter(r => r.avg_val != null);
  if (dailyAvgs.length < 4) return null; // need at least 4 days for a meaningful trend

  const first = dailyAvgs[0].avg_val!;
  const last = dailyAvgs[dailyAvgs.length - 1].avg_val!;
  const days = dailyAvgs.length - 1;
  if (days <= 0) return null;

  const dailyGrowth = (last - first) / days;
  // Skip if growth is less than 1% of current value per day
  if (last > 0 && Math.abs(dailyGrowth / last) < 0.01) return null;
  // Skip if absolute growth is too small to be meaningful
  const minGrowth: Record<string, number> = { cpu_percent: 1, memory_mb: 5, memory_used_mb: 5, load_5: 0.5 };
  if (minGrowth[metric] != null && Math.abs(dailyGrowth) < minGrowth[metric]) return null;

  // Consistency check: at least half of day-over-day changes must agree with the trend direction
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < dailyAvgs.length; i++) {
    const diff = dailyAvgs[i].avg_val! - dailyAvgs[i - 1].avg_val!;
    if (diff > 0) increasing++;
    else if (diff < 0) decreasing++;
  }
  if (dailyGrowth > 0 && increasing < Math.ceil(days / 2)) return null; // not consistently growing
  if (dailyGrowth < 0 && decreasing < Math.ceil(days / 2)) return null;

  // Get the actual latest snapshot value (not the daily average)
  let liveQuery: string;
  let liveParams: string[];
  if (containerName) {
    liveQuery = `SELECT ${metric} as val FROM ${table} WHERE ${hostCol} = ? AND container_name = ? AND status = 'running' ORDER BY collected_at DESC LIMIT 1`;
    liveParams = [hostId, containerName];
  } else {
    liveQuery = `SELECT ${metric} as val FROM ${table} WHERE ${hostCol} = ? ORDER BY collected_at DESC LIMIT 1`;
    liveParams = [hostId];
  }
  const liveRow = db.prepare(liveQuery).get(...liveParams) as LatestSnapshotRow | undefined;
  const liveValue = liveRow?.val ?? null;

  return { current: last, liveValue, dailyGrowth };
}

/**
 * Enrich insights with correlation data.
 * 1. Cascade detection: collapse multiple container availability insights into host-level
 * 2. Temporal correlation: annotate insights with related events
 */
function enrichInsightsWithCorrelations(db: Database.Database): void {
  let modified = 0;

  // --- Cascade detection ---
  const containerAvails = db.prepare(
    "SELECT id, entity_id, title, message FROM insights WHERE entity_type = 'container' AND category = 'availability'"
  ).all() as ContainerAvailRow[];

  const byHost: Record<string, ContainerAvailRow[]> = {};
  for (const ci of containerAvails) {
    const hostId = ci.entity_id.split('/')[0];
    if (!byHost[hostId]) byHost[hostId] = [];
    byHost[hostId].push(ci);
  }

  for (const [hostId, insights] of Object.entries(byHost)) {
    if (insights.length < 3) continue;
    const totalOnHost = db.prepare(
      "SELECT COUNT(DISTINCT container_name) as c FROM container_snapshots WHERE host_id = ? AND collected_at >= datetime('now', '-1 day')"
    ).get(hostId) as TotalOnHostRow;
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
  ).all() as InsightRow[];

  for (const insight of allInsights) {
    if (insight.category === 'availability') continue;

    const hostId = insight.entity_type === 'host'
      ? insight.entity_id
      : insight.entity_id.split('/')[0];

    const recentEvents = db.prepare(`
      WITH ordered AS (
        SELECT container_name, status,
          LAG(status) OVER (PARTITION BY container_name ORDER BY collected_at) as prev_status
        FROM container_snapshots
        WHERE host_id = ? AND collected_at >= datetime('now', '-2 hours')
      )
      SELECT container_name, status as new_status, prev_status as old_status
      FROM ordered
      WHERE status != prev_status AND prev_status IS NOT NULL
    `).all(hostId) as StatusChangeRow[];

    const recentAlerts = db.prepare(`
      SELECT alert_type, target FROM alert_state
      WHERE host_id = ? AND triggered_at >= datetime('now', '-1 hour')
      ORDER BY triggered_at DESC
    `).all(hostId) as AlertStateRow[];

    const correlations: string[] = [];
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
function getBaselines(db: Database.Database, entityType: string, entityId: string, hour?: number): Record<string, BaselineRow> {
  if (hour == null) hour = new Date().getUTCHours();
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

/** Skip insightd's own containers — their resource usage isn't actionable by the user */
function isInsightdContainer(name: string): boolean {
  return name.startsWith('insightd-');
}

/**
 * Minimum absolute deviation above P95 before a "sustained elevation" insight fires.
 * Prevents noise from tiny deviations (e.g. 111 MB vs 106 MB P95).
 */
const MIN_ABSOLUTE_DEVIATION: Record<string, number> = {
  cpu_percent: 10,      // need to be 10%+ above P95
  memory_used_mb: 100,  // need to be 100MB+ above P95 for hosts
  memory_mb: 50,        // need to be 50MB+ above P95 for containers
  load_5: 1.0,          // need load to be 1.0+ above P95
};

/**
 * Minimum current absolute values for trend insights.
 * Prevents "7x growth" on 4→33 MB containers.
 */
const MIN_TREND_VALUE: Record<string, number> = {
  cpu_percent: 10,      // ignore CPU trend below 10%
  memory_used_mb: 200,  // ignore host mem trend below 200 MB
  memory_mb: 100,       // ignore container mem trend below 100 MB
};

module.exports = { generateInsights, getBaselines };
