import type Database from 'better-sqlite3';
import logger = require('../../shared/utils/logger');

interface ContainerSnapshot {
  name: string;
  id: string;
  status: string;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  restartCount: number;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
  blkioReadBytes?: number | null;
  blkioWriteBytes?: number | null;
  healthStatus?: string | null;
  labels?: Record<string, string> | string | null;
}

interface DiskResult {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  usedPercent: number;
}

interface UpdateResult {
  containerName: string;
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  hasUpdate: boolean;
}

interface HostData {
  cpuPercent?: number | null;
  memory?: {
    totalMb?: number | null;
    usedMb?: number | null;
    availableMb?: number | null;
    swapTotalMb?: number | null;
    swapUsedMb?: number | null;
  };
  load?: {
    load1?: number | null;
    load5?: number | null;
    load15?: number | null;
  };
  uptimeSeconds?: number | null;
  gpuUtilizationPercent?: number | null;
  gpuMemoryUsedMb?: number | null;
  gpuMemoryTotalMb?: number | null;
  gpuTemperatureCelsius?: number | null;
  cpuTemperatureCelsius?: number | null;
  diskReadBytesPerSec?: number | null;
  diskWriteBytesPerSec?: number | null;
  netRxBytesPerSec?: number | null;
  netTxBytesPerSec?: number | null;
}

/**
 * Ingest collected container data into the database.
 */
function ingestContainers(db: Database.Database, hostId: string, containers: ContainerSnapshot[]): void {
  const insert = db.prepare(`
    INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items: ContainerSnapshot[]) => {
    for (const c of items) {
      const labels = typeof c.labels === 'object' ? JSON.stringify(c.labels) : (c.labels || null);
      insert.run(hostId, c.name, c.id, c.status, c.cpuPercent ?? null, c.memoryMb ?? null, c.restartCount,
        c.networkRxBytes ?? null, c.networkTxBytes ?? null, c.blkioReadBytes ?? null, c.blkioWriteBytes ?? null, c.healthStatus ?? null, labels);
    }
  });

  insertMany(containers);
  logger.info('ingest', `Stored ${containers.length} container snapshots for ${hostId}`);
}

/**
 * Ingest collected disk data into the database.
 */
function ingestDisk(db: Database.Database, hostId: string, diskResults: DiskResult[]): void {
  const insert = db.prepare(`
    INSERT INTO disk_snapshots (host_id, mount_point, total_gb, used_gb, used_percent, collected_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items: DiskResult[]) => {
    for (const d of items) {
      insert.run(hostId, d.mountPoint, d.totalGb, d.usedGb, d.usedPercent);
    }
  });

  if (diskResults.length > 0) {
    insertMany(diskResults);
  }
}

/**
 * Ingest update check results into the database.
 */
function ingestUpdates(db: Database.Database, hostId: string, updates: UpdateResult[]): void {
  const insert = db.prepare(`
    INSERT INTO update_checks (host_id, container_name, image, local_digest, remote_digest, has_update, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items: UpdateResult[]) => {
    for (const u of items) {
      insert.run(hostId, u.containerName, u.image, u.localDigest, u.remoteDigest, u.hasUpdate ? 1 : 0);
    }
  });

  if (updates.length > 0) {
    insertMany(updates);
  }
}

/**
 * Update or insert host record.
 */
function upsertHost(db: Database.Database, hostId: string, agentVersion?: string): void {
  if (agentVersion) {
    db.prepare(`
      INSERT INTO hosts (host_id, first_seen, last_seen, agent_version)
      VALUES (?, datetime('now'), datetime('now'), ?)
      ON CONFLICT(host_id) DO UPDATE SET last_seen = datetime('now'), agent_version = excluded.agent_version
    `).run(hostId, agentVersion);
  } else {
    db.prepare(`
      INSERT INTO hosts (host_id, first_seen, last_seen)
      VALUES (?, datetime('now'), datetime('now'))
      ON CONFLICT(host_id) DO UPDATE SET last_seen = datetime('now')
    `).run(hostId);
  }
}

/**
 * Ingest host-level system metrics into the database.
 */
function ingestHost(db: Database.Database, hostId: string, hostData: HostData | null): void {
  if (!hostData) return;
  db.prepare(`
    INSERT INTO host_snapshots (host_id, cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb,
      swap_total_mb, swap_used_mb, load_1, load_5, load_15, uptime_seconds,
      gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb, gpu_temperature_celsius, cpu_temperature_celsius,
      disk_read_bytes_per_sec, disk_write_bytes_per_sec, net_rx_bytes_per_sec, net_tx_bytes_per_sec, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    hostId,
    hostData.cpuPercent ?? null,
    hostData.memory?.totalMb ?? null,
    hostData.memory?.usedMb ?? null,
    hostData.memory?.availableMb ?? null,
    hostData.memory?.swapTotalMb ?? null,
    hostData.memory?.swapUsedMb ?? null,
    hostData.load?.load1 ?? null,
    hostData.load?.load5 ?? null,
    hostData.load?.load15 ?? null,
    hostData.uptimeSeconds ?? null,
    hostData.gpuUtilizationPercent ?? null,
    hostData.gpuMemoryUsedMb ?? null,
    hostData.gpuMemoryTotalMb ?? null,
    hostData.gpuTemperatureCelsius ?? null,
    hostData.cpuTemperatureCelsius ?? null,
    hostData.diskReadBytesPerSec ?? null,
    hostData.diskWriteBytesPerSec ?? null,
    hostData.netRxBytesPerSec ?? null,
    hostData.netTxBytesPerSec ?? null
  );
}

module.exports = { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost };
