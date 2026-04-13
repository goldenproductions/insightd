/**
 * Build a DiagnosisContext for a container.
 *
 * Assembles all signals needed by diagnosers from existing queries and tables.
 * Pure function — no side effects, no log fetching (logs come from cache).
 */

import type Database from 'better-sqlite3';
import type {
  DiagnosisContext, DiagnosisEntity, BaselineRow, ContainerSnapshotRow,
  TrendDirection, BaselineComparison, DiagnosisLogs,
} from './types';
import { robustZ as computeRobustZ } from '../stats';

const { getBaselines } = require('../detector') as {
  getBaselines: (db: Database.Database, entityType: string, entityId: string, hour?: number) => Record<string, BaselineRow>;
};

// Noise floor per metric: below this absolute deviation from the median we
// short-circuit to 'normal' regardless of robust-z. Prevents idle containers
// (0.3% CPU with a MAD of 0.05) from looking "critical" on tiny fluctuations.
// Mirrors the MIN_ABSOLUTE_DEVIATION constants in detector.ts.
const ROBUST_NOISE_FLOOR: Record<string, number> = {
  cpu_percent: 10,
  memory_mb: 50,
  memory_used_mb: 100,
  load_5: 1,
};

interface LatestContainerRow {
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number;
  health_status: string | null;
  health_check_output: string | null;
  collected_at: string;
}

interface HostMetricRow {
  cpu_percent: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  load_5: number | null;
}

interface HealthScoreRow {
  score: number;
}

interface ContainerSummaryRow {
  container_name: string;
  total: number;
  running: number;
}

interface StatusChangeRow {
  collected_at: string;
  health_status: string | null;
  prev_health: string | null;
}

interface ActiveAlertRow {
  alert_type: string;
  target: string;
  triggered_at: string;
}

/**
 * Compute trend direction from an array of values (oldest to newest).
 * Uses simple first-half vs second-half comparison.
 */
function computeTrend(values: (number | null)[]): TrendDirection {
  const clean = values.filter((v): v is number => v != null);
  if (clean.length < 4) return 'stable';
  const mid = Math.floor(clean.length / 2);
  const firstHalf = clean.slice(0, mid);
  const secondHalf = clean.slice(mid);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const delta = avgSecond - avgFirst;
  const threshold = Math.max(Math.abs(avgFirst) * 0.1, 1); // 10% or absolute 1
  if (delta > threshold) return 'rising';
  if (delta < -threshold) return 'falling';
  return 'stable';
}

/**
 * Rate a value against its baseline using a robust z-score
 * (`|value − p50| / mad`). Bands: `normal` < 2.0 ≤ `elevated` < 3.5 ≤ `critical`.
 * Falls back to the legacy P95 comparison when `mad` is null (e.g. on a
 * baseline that existed before schema v24 and hasn't been recomputed yet),
 * and short-circuits to `normal` when the absolute deviation from the median
 * is below a per-metric noise floor.
 */
function rateAgainstBaseline(
  metric: string,
  value: number | null,
  baseline: BaselineRow | undefined,
): BaselineComparison {
  if (value == null || !baseline || baseline.p50 == null) {
    return legacyP95Compare(value, baseline);
  }
  const med = baseline.p50;
  const madValue = baseline.mad;
  if (madValue == null || madValue === 0) {
    return legacyP95Compare(value, baseline);
  }
  const absDev = Math.abs(value - med);
  const floor = ROBUST_NOISE_FLOOR[metric] ?? 0;
  if (absDev < floor) return 'normal';

  const z = computeRobustZ(value, med, madValue);
  if (z == null) return legacyP95Compare(value, baseline);
  if (z < 2.0) return 'normal';
  if (z < 3.5) return 'elevated';
  return 'critical';
}

function legacyP95Compare(value: number | null, baseline: BaselineRow | undefined): BaselineComparison {
  if (value == null || !baseline || baseline.p95 == null) return null;
  const p95 = baseline.p95;
  if (value <= p95) return 'normal';
  if (value > p95 * 1.3) return 'critical';
  return 'elevated';
}

export function buildContext(db: Database.Database, entity: DiagnosisEntity, logs: DiagnosisLogs): DiagnosisContext {
  const now = new Date();
  const { hostId, containerName } = entity;

  // --- Latest snapshot ---
  const latestRow = db.prepare(`
    SELECT status, cpu_percent, memory_mb, restart_count, health_status, health_check_output, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId, containerName) as LatestContainerRow | undefined;

  if (!latestRow) {
    throw new Error(`No snapshots for ${hostId}/${containerName}`);
  }

  // --- Recent history (last 2 hours) ---
  const recentSnapshots = db.prepare(`
    SELECT status, cpu_percent, memory_mb, restart_count, health_status, health_check_output, collected_at
    FROM container_snapshots
    WHERE host_id = ? AND container_name = ?
      AND collected_at >= datetime('now', '-2 hours')
    ORDER BY collected_at ASC
  `).all(hostId, containerName) as ContainerSnapshotRow[];

  const cpuTrend = computeTrend(recentSnapshots.map(r => r.cpu_percent));
  const memoryTrend = computeTrend(recentSnapshots.map(r => r.memory_mb));

  // Count restarts as deltas between consecutive snapshots (robust to the counter resetting)
  let restartsInWindow = 0;
  for (let i = 1; i < recentSnapshots.length; i++) {
    const delta = recentSnapshots[i]!.restart_count - recentSnapshots[i - 1]!.restart_count;
    if (delta > 0) restartsInWindow += delta;
  }

  // --- Baselines ---
  const entityId = `${hostId}/${containerName}`;
  const baselines = getBaselines(db, 'container', entityId);
  const memoryVsP95 = rateAgainstBaseline('memory_mb', latestRow.memory_mb, baselines.memory_mb);
  const cpuVsP95 = rateAgainstBaseline('cpu_percent', latestRow.cpu_percent, baselines.cpu_percent);

  // --- Unhealthy episode: when did the current unhealthy streak start? ---
  let unhealthySince: string | null = null;
  let unhealthyDurationMinutes: number | null = null;
  if (latestRow.health_status === 'unhealthy') {
    // Walk backwards to find the first snapshot in the unhealthy streak
    const streak = db.prepare(`
      WITH ordered AS (
        SELECT collected_at, health_status,
               LAG(health_status) OVER (ORDER BY collected_at) as prev_health
        FROM container_snapshots
        WHERE host_id = ? AND container_name = ?
          AND collected_at >= datetime('now', '-1 day')
      )
      SELECT collected_at FROM ordered
      WHERE health_status = 'unhealthy' AND (prev_health != 'unhealthy' OR prev_health IS NULL)
      ORDER BY collected_at DESC LIMIT 1
    `).all(hostId, containerName) as StatusChangeRow[];
    if (streak.length > 0) {
      unhealthySince = streak[0]!.collected_at;
      const ms = Date.now() - new Date(unhealthySince + 'Z').getTime();
      unhealthyDurationMinutes = Math.max(0, Math.round(ms / 60000));
    }
  }

  // --- Host state ---
  const hostMetric = db.prepare(`
    SELECT cpu_percent, memory_total_mb, memory_used_mb, load_5
    FROM host_snapshots
    WHERE host_id = ?
    ORDER BY collected_at DESC LIMIT 1
  `).get(hostId) as HostMetricRow | undefined;

  const hostHealth = db.prepare(`
    SELECT score FROM health_scores
    WHERE entity_type = 'host' AND entity_id = ?
  `).get(hostId) as HealthScoreRow | undefined;

  const hostCpuPercent = hostMetric?.cpu_percent ?? null;
  const hostMemoryPercent = hostMetric?.memory_total_mb && hostMetric.memory_used_mb
    ? (hostMetric.memory_used_mb / hostMetric.memory_total_mb) * 100
    : null;
  const hostLoad5 = hostMetric?.load_5 ?? null;

  const underPressure =
    (hostCpuPercent != null && hostCpuPercent > 80) ||
    (hostMemoryPercent != null && hostMemoryPercent > 85) ||
    (hostLoad5 != null && hostLoad5 > 8);

  // --- Coincident failures on this host (last hour) ---
  const hostContainerSummary = db.prepare(`
    SELECT container_name,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
    FROM container_snapshots
    WHERE host_id = ? AND collected_at >= datetime('now', '-1 hour')
    GROUP BY container_name
  `).all(hostId) as ContainerSummaryRow[];

  const recentFailures: string[] = [];
  for (const c of hostContainerSummary) {
    if (c.container_name === containerName) continue;
    if (c.total > 0 && c.running < c.total) {
      recentFailures.push(c.container_name);
    }
  }
  const cascadeDetected = hostContainerSummary.length > 0
    && (recentFailures.length + 1) >= hostContainerSummary.length * 0.5
    && recentFailures.length >= 2;

  // --- Active alerts on this host ---
  const activeAlerts = db.prepare(`
    SELECT alert_type, target, triggered_at
    FROM alert_state
    WHERE host_id = ? AND resolved_at IS NULL
    ORDER BY triggered_at DESC
  `).all(hostId) as ActiveAlertRow[];

  return {
    entity,
    now,
    latest: {
      status: latestRow.status,
      cpuPercent: latestRow.cpu_percent,
      memoryMb: latestRow.memory_mb,
      restartCount: latestRow.restart_count,
      healthStatus: latestRow.health_status,
      healthCheckOutput: latestRow.health_check_output,
      collectedAt: latestRow.collected_at,
    },
    recent: {
      snapshots: recentSnapshots,
      cpuTrend,
      memoryTrend,
      restartsInWindow,
    },
    baselines,
    memoryVsP95,
    cpuVsP95,
    unhealthy: {
      since: unhealthySince,
      durationMinutes: unhealthyDurationMinutes,
    },
    host: {
      healthScore: hostHealth?.score ?? null,
      cpuPercent: hostCpuPercent,
      memoryPercent: hostMemoryPercent,
      load5: hostLoad5,
      underPressure,
    },
    coincident: {
      activeAlerts,
      recentFailures,
      cascadeDetected,
    },
    logs,
  };
}

module.exports = { buildContext };
