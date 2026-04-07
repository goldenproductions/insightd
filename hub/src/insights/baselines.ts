import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');

const HOST_METRICS: string[] = [
  'cpu_percent', 'memory_used_mb', 'load_1', 'load_5', 'swap_used_mb',
  'gpu_utilization_percent', 'cpu_temperature_celsius', 'gpu_temperature_celsius',
  'disk_read_bytes_per_sec', 'disk_write_bytes_per_sec',
  'net_rx_bytes_per_sec', 'net_tx_bytes_per_sec',
];

const CONTAINER_METRICS: string[] = ['cpu_percent', 'memory_mb'];

interface TimePeriod {
  bucket: string;
  hours: number[];
}

const TIME_PERIODS: TimePeriod[] = [
  { bucket: 'night', hours: [0, 1, 2, 3] },
  { bucket: 'early_morning', hours: [4, 5, 6, 7] },
  { bucket: 'morning', hours: [8, 9, 10, 11] },
  { bucket: 'afternoon', hours: [12, 13, 14, 15] },
  { bucket: 'evening', hours: [16, 17, 18, 19] },
  { bucket: 'late_evening', hours: [20, 21, 22, 23] },
];

const MIN_PERIOD_SAMPLES: number = 48;

function getTimePeriod(hour: number): string {
  for (const tp of TIME_PERIODS) {
    if (tp.hours.includes(hour)) return tp.bucket;
  }
  return 'all';
}

interface Percentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  min: number | undefined;
  max: number | undefined;
  count: number;
}

/**
 * Compute percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const frac = idx - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return Math.round((sorted[lower] + frac * (sorted[lower + 1] - sorted[lower])) * 100) / 100;
}

function computePercentiles(values: number[]): Percentiles {
  return {
    p50: percentile(values, 50), p75: percentile(values, 75), p90: percentile(values, 90),
    p95: percentile(values, 95), p99: percentile(values, 99),
    min: values[0], max: values[values.length - 1], count: values.length,
  };
}

interface HostSnapshotRow {
  host_id: string;
  dow: string;
  hour: number;
  [key: string]: any;
}

interface ContainerSnapshotRow {
  host_id: string;
  container_name: string;
  dow: string;
  hour: number;
  [key: string]: any;
}

/**
 * Compute and store baselines for all hosts and containers.
 */
function computeBaselines(db: Database.Database): void {
  const upsert = db.prepare(`
    INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id, metric, time_bucket) DO UPDATE SET
      p50=excluded.p50, p75=excluded.p75, p90=excluded.p90, p95=excluded.p95, p99=excluded.p99,
      min_val=excluded.min_val, max_val=excluded.max_val, sample_count=excluded.sample_count, computed_at=excluded.computed_at
  `);

  function upsertBucket(entityType: string, entityId: string, metric: string, bucket: string, values: number[]): boolean {
    if (values.length === 0) return false;
    const p = computePercentiles(values);
    upsert.run(entityType, entityId, metric, bucket, p.p50, p.p75, p.p90, p.p95, p.p99, p.min, p.max, p.count);
    return true;
  }

  let count = 0;

  // --- Host baselines ---
  const hosts = db.prepare("SELECT DISTINCT host_id FROM host_snapshots WHERE collected_at >= datetime('now', '-30 days')").all() as { host_id: string }[];

  for (const { host_id } of hosts) {
    const rows = db.prepare(`
      SELECT *, strftime('%w', collected_at) as dow, CAST(strftime('%H', collected_at) AS INTEGER) as hour
      FROM host_snapshots
      WHERE host_id = ? AND collected_at >= datetime('now', '-30 days')
      ORDER BY collected_at
    `).all(host_id) as HostSnapshotRow[];

    for (const metric of HOST_METRICS) {
      const allValues = rows.map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
      const weekdayValues = rows.filter(r => Number(r.dow) >= 1 && Number(r.dow) <= 5).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
      const weekendValues = rows.filter(r => Number(r.dow) == 0 || Number(r.dow) == 6).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);

      if (upsertBucket('host', host_id, metric, 'all', allValues)) count++;
      if (upsertBucket('host', host_id, metric, 'weekday', weekdayValues)) count++;
      if (upsertBucket('host', host_id, metric, 'weekend', weekendValues)) count++;

      // Time-period baselines
      for (const tp of TIME_PERIODS) {
        const periodValues = rows.filter(r => tp.hours.includes(r.hour)).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
        if (periodValues.length >= MIN_PERIOD_SAMPLES) {
          if (upsertBucket('host', host_id, metric, tp.bucket, periodValues)) count++;
        }
      }
    }
  }

  // --- Container baselines ---
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-30 days')
  `).all() as { host_id: string; container_name: string }[];

  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    const rows = db.prepare(`
      SELECT *, strftime('%w', collected_at) as dow, CAST(strftime('%H', collected_at) AS INTEGER) as hour
      FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-30 days') AND status = 'running'
      ORDER BY collected_at
    `).all(host_id, container_name) as ContainerSnapshotRow[];

    for (const metric of CONTAINER_METRICS) {
      const allValues = rows.map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
      const weekdayValues = rows.filter(r => Number(r.dow) >= 1 && Number(r.dow) <= 5).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
      const weekendValues = rows.filter(r => Number(r.dow) == 0 || Number(r.dow) == 6).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);

      if (upsertBucket('container', entityId, metric, 'all', allValues)) count++;
      if (upsertBucket('container', entityId, metric, 'weekday', weekdayValues)) count++;
      if (upsertBucket('container', entityId, metric, 'weekend', weekendValues)) count++;

      for (const tp of TIME_PERIODS) {
        const periodValues = rows.filter(r => tp.hours.includes(r.hour)).map(r => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
        if (periodValues.length >= MIN_PERIOD_SAMPLES) {
          if (upsertBucket('container', entityId, metric, tp.bucket, periodValues)) count++;
        }
      }
    }
  }

  if (count > 0) {
    logger.info('baselines', `Computed ${count} baselines for ${hosts.length} hosts and ${containers.length} containers`);
  }
}

module.exports = { computeBaselines, percentile, HOST_METRICS, CONTAINER_METRICS, TIME_PERIODS, getTimePeriod, MIN_PERIOD_SAMPLES };
