/**
 * Seasonal Hybrid ESD (S-H-ESD) anomaly detection on hourly rollups.
 *
 * Based on Twitter's AnomalyDetection (Vallis et al., 2014). We strip a
 * simple seasonal component via a rolling median, then run generalized ESD
 * on the residuals to detect points that deviate more than ~3.5 MAD units
 * from their seasonal neighborhood.
 *
 * Why rolling median instead of full STL decomposition:
 *   - At homelab scale (up to ~500 hourly samples per series) an O(n·window)
 *     rolling median is still sub-millisecond per pass, and STL's extra
 *     smoothing layers don't materially change detection quality.
 *   - It degrades gracefully when the series is short (< 7 days): we skip
 *     detection rather than produce flaky anomalies from an unstable model.
 *
 * Results are written to `rollup_anomalies` so diagnosers and the UI can
 * surface them without re-running the math. The table has UNIQUE
 * (entity_type, entity_id, metric, bucket) so re-runs are idempotent.
 */

import type Database from 'better-sqlite3';
import logger = require('../../../../shared/utils/logger');
import { rollingMedian, mad as madFn, esdTest, median } from '../stats';

const MIN_SERIES_LENGTH = 168;      // 7 days of hourly samples
const SEASONAL_WINDOW = 24 * 7;     // 1 week sliding window
const MAX_SERIES_LENGTH = 24 * 14;  // 14 days cap so we don't waste cycles
const MAX_OUTLIER_FRACTION = 0.02;  // at most 2% of points can be anomalies
const ROBUST_Z_THRESHOLD = 3.5;     // matches Phase 2 detector/context bands

interface RollupRow {
  bucket: string;
  value: number;
}

interface AnomalySpec {
  entityType: string;
  entityId: string;
  metric: string;
  loader: (db: Database.Database) => RollupRow[];
}

/**
 * One definition per (entity, metric) pair we want to watch. Only hourly
 * rollups the engine already computes — no new collection.
 */
function buildSpecs(db: Database.Database): AnomalySpec[] {
  const hosts = db.prepare('SELECT DISTINCT host_id FROM host_rollups').all() as Array<{ host_id: string }>;
  const containers = db.prepare(
    'SELECT DISTINCT host_id, container_name FROM container_rollups'
  ).all() as Array<{ host_id: string; container_name: string }>;

  const specs: AnomalySpec[] = [];

  for (const { host_id } of hosts) {
    for (const metric of ['cpu_max', 'mem_used_max'] as const) {
      specs.push({
        entityType: 'host',
        entityId: host_id,
        metric,
        loader: (d) => d.prepare(
          `SELECT bucket, ${metric} AS value FROM host_rollups
           WHERE host_id = ? AND ${metric} IS NOT NULL
           ORDER BY bucket DESC LIMIT ${MAX_SERIES_LENGTH}`,
        ).all(host_id) as RollupRow[],
      });
    }
  }

  for (const { host_id, container_name } of containers) {
    for (const metric of ['cpu_max', 'mem_max'] as const) {
      specs.push({
        entityType: 'container',
        entityId: `${host_id}/${container_name}`,
        metric,
        loader: (d) => d.prepare(
          `SELECT bucket, ${metric} AS value FROM container_rollups
           WHERE host_id = ? AND container_name = ? AND ${metric} IS NOT NULL
           ORDER BY bucket DESC LIMIT ${MAX_SERIES_LENGTH}`,
        ).all(host_id, container_name) as RollupRow[],
      });
    }
  }

  return specs;
}

interface AnomalyRow {
  entityType: string;
  entityId: string;
  metric: string;
  bucket: string;
  value: number;
  residual: number;
  robustZ: number;
}

function runSpec(db: Database.Database, spec: AnomalySpec): AnomalyRow[] {
  const raw = spec.loader(db);
  if (raw.length < MIN_SERIES_LENGTH) return [];

  // DESC load for performance; flip to ASC for analysis.
  const series = raw.slice().reverse();
  const values = series.map((r) => r.value);

  const seasonal = rollingMedian(values, SEASONAL_WINDOW);
  const residuals = values.map((v, i) => v - seasonal[i]!);

  // Use a standalone median/MAD on residuals to report the per-anomaly
  // robust-z cleanly (esdTest only returns indices, not the final score).
  const med = median(residuals.slice());
  const d = madFn(residuals);
  if (med == null || d == null || d === 0) return [];

  const maxOutliers = Math.max(1, Math.floor(residuals.length * MAX_OUTLIER_FRACTION));
  const indices = esdTest(residuals, maxOutliers, ROBUST_Z_THRESHOLD);

  const results: AnomalyRow[] = [];
  for (const i of indices) {
    const value = values[i]!;
    const residual = residuals[i]!;
    const z = Math.abs(residual - med) / d;
    results.push({
      entityType: spec.entityType,
      entityId: spec.entityId,
      metric: spec.metric,
      bucket: series[i]!.bucket,
      value,
      residual,
      robustZ: Math.round(z * 100) / 100,
    });
  }
  return results;
}

/**
 * Run S-H-ESD across every eligible (entity, metric) series and upsert
 * detected anomalies into `rollup_anomalies`. Never throws — errors are
 * logged and the pass continues with the next series.
 */
export function runAnomalyDetection(db: Database.Database): number {
  const specs = buildSpecs(db);
  const upsert = db.prepare(`
    INSERT INTO rollup_anomalies
      (entity_type, entity_id, metric, bucket, value, residual, robust_z)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, metric, bucket) DO UPDATE SET
      value = excluded.value,
      residual = excluded.residual,
      robust_z = excluded.robust_z,
      detected_at = datetime('now')
  `);

  let total = 0;
  const tx = db.transaction((rows: AnomalyRow[]) => {
    for (const r of rows) {
      upsert.run(r.entityType, r.entityId, r.metric, r.bucket, r.value, r.residual, r.robustZ);
    }
  });

  for (const spec of specs) {
    try {
      const rows = runSpec(db, spec);
      if (rows.length > 0) {
        tx(rows);
        total += rows.length;
      }
    } catch (err) {
      logger.warn('anomaly', `S-H-ESD failed for ${spec.entityType} ${spec.entityId} ${spec.metric}: ${(err as Error).message}`);
    }
  }

  if (total > 0) {
    logger.info('anomaly', `S-H-ESD detected ${total} rollup anomalies across ${specs.length} series`);
  }
  return total;
}

module.exports = { runAnomalyDetection };
