const logger = require('../../../shared/utils/logger');

const HOST_METRICS = [
  'cpu_percent', 'memory_used_mb', 'load_1', 'load_5', 'swap_used_mb',
  'gpu_utilization_percent', 'cpu_temperature_celsius', 'gpu_temperature_celsius',
  'disk_read_bytes_per_sec', 'disk_write_bytes_per_sec',
  'net_rx_bytes_per_sec', 'net_tx_bytes_per_sec',
];

const CONTAINER_METRICS = ['cpu_percent', 'memory_mb'];

/**
 * Compute percentile from a sorted array of numbers.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const frac = idx - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return Math.round((sorted[lower] + frac * (sorted[lower + 1] - sorted[lower])) * 100) / 100;
}

/**
 * Compute and store baselines for all hosts and containers.
 * Queries up to 30 days of history, computes percentiles, UPSERTs into baselines table.
 */
function computeBaselines(db) {
  const upsert = db.prepare(`
    INSERT INTO baselines (entity_type, entity_id, metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id, metric, time_bucket) DO UPDATE SET
      p50=excluded.p50, p75=excluded.p75, p90=excluded.p90, p95=excluded.p95, p99=excluded.p99,
      min_val=excluded.min_val, max_val=excluded.max_val, sample_count=excluded.sample_count, computed_at=excluded.computed_at
  `);

  let count = 0;

  // --- Host baselines ---
  const hosts = db.prepare("SELECT DISTINCT host_id FROM host_snapshots WHERE collected_at >= datetime('now', '-30 days')").all();

  for (const { host_id } of hosts) {
    const rows = db.prepare(`
      SELECT *, strftime('%w', collected_at) as dow FROM host_snapshots
      WHERE host_id = ? AND collected_at >= datetime('now', '-30 days')
      ORDER BY collected_at
    `).all(host_id);

    for (const metric of HOST_METRICS) {
      const allValues = rows.map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);
      const weekdayValues = rows.filter(r => r.dow >= 1 && r.dow <= 5).map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);
      const weekendValues = rows.filter(r => r.dow == 0 || r.dow == 6).map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);

      for (const [bucket, values] of [['all', allValues], ['weekday', weekdayValues], ['weekend', weekendValues]]) {
        if (values.length === 0) continue;
        upsert.run('host', host_id, metric, bucket,
          percentile(values, 50), percentile(values, 75), percentile(values, 90),
          percentile(values, 95), percentile(values, 99),
          values[0], values[values.length - 1], values.length);
        count++;
      }
    }
  }

  // --- Container baselines ---
  const containers = db.prepare(`
    SELECT DISTINCT host_id, container_name FROM container_snapshots
    WHERE collected_at >= datetime('now', '-30 days')
  `).all();

  for (const { host_id, container_name } of containers) {
    const entityId = `${host_id}/${container_name}`;
    const rows = db.prepare(`
      SELECT *, strftime('%w', collected_at) as dow FROM container_snapshots
      WHERE host_id = ? AND container_name = ? AND collected_at >= datetime('now', '-30 days') AND status = 'running'
      ORDER BY collected_at
    `).all(host_id, container_name);

    for (const metric of CONTAINER_METRICS) {
      const allValues = rows.map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);
      const weekdayValues = rows.filter(r => r.dow >= 1 && r.dow <= 5).map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);
      const weekendValues = rows.filter(r => r.dow == 0 || r.dow == 6).map(r => r[metric]).filter(v => v != null).sort((a, b) => a - b);

      for (const [bucket, values] of [['all', allValues], ['weekday', weekdayValues], ['weekend', weekendValues]]) {
        if (values.length === 0) continue;
        upsert.run('container', entityId, metric, bucket,
          percentile(values, 50), percentile(values, 75), percentile(values, 90),
          percentile(values, 95), percentile(values, 99),
          values[0], values[values.length - 1], values.length);
        count++;
      }
    }
  }

  if (count > 0) {
    logger.info('baselines', `Computed ${count} baselines for ${hosts.length} hosts and ${containers.length} containers`);
  }
}

module.exports = { computeBaselines, percentile, HOST_METRICS, CONTAINER_METRICS };
