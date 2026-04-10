import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');

/**
 * Compute hourly rollups from raw snapshot data.
 * Processes one day at a time to bound transaction size.
 * Uses INSERT OR IGNORE — safe to re-run (idempotent).
 */
function computeRollups(db: Database.Database): void {
  const lastRollup = getMetaValue(db, 'last_rollup_at');
  // Default to 7 days ago on first run; never earlier than available data
  const startFrom = lastRollup || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  // Stop 2 hours ago to avoid rolling up partial hours
  const stopBefore = new Date(Date.now() - 2 * 3600000).toISOString().slice(0, 13) + ':00:00';

  if (startFrom >= stopBefore) return; // nothing to roll up

  // Process one day at a time
  let cursor = startFrom;
  while (cursor < stopBefore) {
    const nextDay = advanceDay(cursor, stopBefore);
    rollupHostSnapshots(db, cursor, nextDay);
    rollupContainerSnapshots(db, cursor, nextDay);
    rollupDiskSnapshots(db, cursor, nextDay);
    rollupHttpChecks(db, cursor, nextDay);
    cursor = nextDay;
  }

  setMetaValue(db, 'last_rollup_at', stopBefore);
  logger.info('rollups', `Rolled up data from ${startFrom} to ${stopBefore}`);
}

function advanceDay(cursor: string, stopBefore: string): string {
  const next = new Date(new Date(cursor + 'Z').getTime() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return next < stopBefore ? next : stopBefore;
}

function rollupHostSnapshots(db: Database.Database, from: string, to: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO host_rollups
      (host_id, bucket, cpu_avg, cpu_max, mem_used_avg, mem_used_max, mem_total,
       load_1_avg, load_1_max, swap_used_avg, gpu_util_avg, cpu_temp_avg,
       disk_read_avg, disk_write_avg, net_rx_avg, net_tx_avg, sample_count)
    SELECT
      host_id,
      strftime('%Y-%m-%dT%H:00:00', collected_at) AS bucket,
      AVG(cpu_percent), MAX(cpu_percent),
      AVG(memory_used_mb), MAX(memory_used_mb), AVG(memory_total_mb),
      AVG(load_1), MAX(load_1),
      AVG(swap_used_mb),
      AVG(gpu_utilization_percent), AVG(cpu_temperature_celsius),
      AVG(disk_read_bytes_per_sec), AVG(disk_write_bytes_per_sec),
      AVG(net_rx_bytes_per_sec), AVG(net_tx_bytes_per_sec),
      COUNT(*)
    FROM host_snapshots
    WHERE collected_at >= ? AND collected_at < ?
    GROUP BY host_id, bucket
  `).run(from, to);
}

function rollupContainerSnapshots(db: Database.Database, from: string, to: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO container_rollups
      (host_id, container_name, bucket, status_running, status_total,
       cpu_avg, cpu_max, mem_avg, mem_max,
       net_rx_bytes, net_tx_bytes, restart_count, sample_count)
    SELECT
      host_id,
      container_name,
      strftime('%Y-%m-%dT%H:00:00', collected_at) AS bucket,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),
      COUNT(*),
      AVG(cpu_percent), MAX(cpu_percent),
      AVG(memory_mb), MAX(memory_mb),
      MAX(network_rx_bytes), MAX(network_tx_bytes),
      MAX(restart_count),
      COUNT(*)
    FROM container_snapshots
    WHERE collected_at >= ? AND collected_at < ?
    GROUP BY host_id, container_name, bucket
  `).run(from, to);
}

function rollupDiskSnapshots(db: Database.Database, from: string, to: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO disk_rollups
      (host_id, mount_point, bucket, used_avg, used_max, total_gb, sample_count)
    SELECT
      host_id,
      mount_point,
      strftime('%Y-%m-%dT%H:00:00', collected_at) AS bucket,
      AVG(used_gb), MAX(used_gb),
      AVG(total_gb),
      COUNT(*)
    FROM disk_snapshots
    WHERE collected_at >= ? AND collected_at < ?
    GROUP BY host_id, mount_point, bucket
  `).run(from, to);
}

function rollupHttpChecks(db: Database.Database, from: string, to: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO http_rollups
      (endpoint_id, bucket, response_avg_ms, response_max_ms,
       up_count, total_count, sample_count)
    SELECT
      endpoint_id,
      strftime('%Y-%m-%dT%H:00:00', checked_at) AS bucket,
      AVG(response_time_ms), MAX(response_time_ms),
      SUM(is_up), COUNT(*),
      COUNT(*)
    FROM http_checks
    WHERE checked_at >= ? AND checked_at < ?
    GROUP BY endpoint_id, bucket
  `).run(from, to);
}

function getMetaValue(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function setMetaValue(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = { computeRollups, getMetaValue, setMetaValue };
