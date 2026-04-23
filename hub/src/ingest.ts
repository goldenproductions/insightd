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
  healthCheckOutput?: string | null;
  labels?: Record<string, string> | string | null;
  exitCode?: number | null;
  sizeRootfsBytes?: number | null;
  sizeRwBytes?: number | null;
}

interface DiskResult {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  usedPercent: number;
}

interface VolumeResult {
  name: string;
  driver: string;
  mountpoint: string | null;
  sizeBytes: number | null;
  refCount: number | null;
  createdAt: string | null;
  labels: string | Record<string, string> | null;
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
 *
 * Each published batch IS the authoritative "currently present" set for the
 * host (agent/src/scheduler.ts only publishes on successful collection), so
 * we diff against the `containers` registry: present containers are upserted
 * with `removed_at = NULL`, and any previously-active row whose `last_seen`
 * falls behind this batch is stamped with `removed_at`. That's how deleted
 * containers stop appearing in the UI within one cycle instead of waiting
 * out a 15-minute staleness window.
 */
function ingestContainers(db: Database.Database, hostId: string, containers: ContainerSnapshot[]): void {
  const insert = db.prepare(`
    INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status, health_check_output, labels, exit_code, size_rootfs_bytes, size_rw_bytes, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertRegistry = db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(host_id, container_name) DO UPDATE SET
      last_seen = excluded.last_seen,
      removed_at = NULL
  `);
  const markRemoved = db.prepare(`
    UPDATE containers
       SET removed_at = ?
     WHERE host_id = ? AND removed_at IS NULL AND last_seen < ?
  `);

  const ingestBatch = db.transaction((items: ContainerSnapshot[]) => {
    const batchAt = (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
    for (const c of items) {
      const labels = typeof c.labels === 'object' ? JSON.stringify(c.labels) : (c.labels || null);
      insert.run(hostId, c.name, c.id, c.status, c.cpuPercent ?? null, c.memoryMb ?? null, c.restartCount,
        c.networkRxBytes ?? null, c.networkTxBytes ?? null, c.blkioReadBytes ?? null, c.blkioWriteBytes ?? null, c.healthStatus ?? null, c.healthCheckOutput ?? null, labels, c.exitCode ?? null,
        c.sizeRootfsBytes ?? null, c.sizeRwBytes ?? null, batchAt);
      upsertRegistry.run(hostId, c.name, batchAt, batchAt);
    }
    markRemoved.run(batchAt, hostId, batchAt);
  });

  ingestBatch(containers);
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
 * Ingest Docker volume inventory into the database. One row per volume per
 * cycle. Queries take the latest snapshot per (host, volume_name), so stale
 * rows for volumes the host no longer has will naturally age out — but we
 * don't try to "mark removed" the way containers do.
 */
function ingestVolumes(db: Database.Database, hostId: string, volumes: VolumeResult[]): void {
  const insert = db.prepare(`
    INSERT INTO volume_snapshots
    (host_id, volume_name, driver, mountpoint, size_bytes, ref_count, created_at, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMany = db.transaction((items: VolumeResult[]) => {
    for (const v of items) {
      const labels = typeof v.labels === 'object' && v.labels !== null
        ? JSON.stringify(v.labels)
        : (v.labels ?? null);
      insert.run(
        hostId, v.name, v.driver, v.mountpoint ?? null,
        v.sizeBytes ?? null, v.refCount ?? null, v.createdAt ?? null, labels,
      );
    }
  });
  if (volumes.length > 0) insertMany(volumes);
  logger.info('ingest', `Stored ${volumes.length} volume snapshots for ${hostId}`);
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
function upsertHost(db: Database.Database, hostId: string, agentVersion?: string | null, runtimeType?: string, hostGroup?: string | null): void {
  const rt = runtimeType || 'docker';
  // Empty string → NULL so the UI treats it as ungrouped.
  const group = hostGroup && hostGroup.length > 0 ? hostGroup : null;
  if (agentVersion) {
    db.prepare(`
      INSERT INTO hosts (host_id, first_seen, last_seen, agent_version, runtime_type, host_group)
      VALUES (?, datetime('now'), datetime('now'), ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        last_seen = datetime('now'),
        agent_version = excluded.agent_version,
        runtime_type = excluded.runtime_type,
        host_group = excluded.host_group
    `).run(hostId, agentVersion, rt, group);
  } else {
    db.prepare(`
      INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, host_group)
      VALUES (?, datetime('now'), datetime('now'), ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        last_seen = datetime('now'),
        runtime_type = excluded.runtime_type,
        host_group = excluded.host_group
    `).run(hostId, rt, group);
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

interface PvRecord {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimNamespace: string | null;
  claimName: string | null;
  csiDriver: string | null;
  createdAt: string | null;
  labels: string | Record<string, string> | null;
}

interface PvcRecord {
  namespace: string;
  name: string;
  phase: string;
  storageClass: string | null;
  requestBytes: number | null;
  capacityBytes: number | null;
  accessModes: string[];
  volumeName: string | null;
  volumeMode: string | null;
  createdAt: string | null;
  labels: string | Record<string, string> | null;
}

/**
 * Ingest a batch of PersistentVolume snapshots for a cluster. Like
 * ingestVolumes, this inserts fresh rows per cycle — queries pick the latest
 * batch per cluster_id via MAX(collected_at), so stale rows for deleted PVs
 * naturally fall off.
 */
function ingestPvs(db: Database.Database, clusterId: string, pvs: PvRecord[]): void {
  const insert = db.prepare(`
    INSERT INTO pv_snapshots
    (cluster_id, pv_name, phase, capacity_bytes, access_modes, reclaim_policy,
     storage_class, volume_mode, claim_namespace, claim_name, csi_driver,
     created_at, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMany = db.transaction((items: PvRecord[]) => {
    for (const p of items) {
      const labels = typeof p.labels === 'object' && p.labels !== null
        ? JSON.stringify(p.labels)
        : (p.labels ?? null);
      insert.run(
        clusterId, p.name, p.phase, p.capacityBytes ?? null,
        JSON.stringify(p.accessModes ?? []),
        p.reclaimPolicy ?? null, p.storageClass ?? null, p.volumeMode ?? null,
        p.claimNamespace ?? null, p.claimName ?? null, p.csiDriver ?? null,
        p.createdAt ?? null, labels,
      );
    }
  });
  if (pvs.length > 0) insertMany(pvs);
  logger.info('ingest', `Stored ${pvs.length} PV snapshots for cluster ${clusterId}`);
}

function ingestPvcs(db: Database.Database, clusterId: string, pvcs: PvcRecord[]): void {
  const insert = db.prepare(`
    INSERT INTO pvc_snapshots
    (cluster_id, namespace, pvc_name, phase, storage_class, request_bytes,
     capacity_bytes, access_modes, volume_name, volume_mode,
     created_at, labels, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMany = db.transaction((items: PvcRecord[]) => {
    for (const p of items) {
      const labels = typeof p.labels === 'object' && p.labels !== null
        ? JSON.stringify(p.labels)
        : (p.labels ?? null);
      insert.run(
        clusterId, p.namespace, p.name, p.phase, p.storageClass ?? null,
        p.requestBytes ?? null, p.capacityBytes ?? null,
        JSON.stringify(p.accessModes ?? []),
        p.volumeName ?? null, p.volumeMode ?? null,
        p.createdAt ?? null, labels,
      );
    }
  });
  if (pvcs.length > 0) insertMany(pvcs);
  logger.info('ingest', `Stored ${pvcs.length} PVC snapshots for cluster ${clusterId}`);
}

interface EventRecord {
  eventUid: string;
  namespace: string | null;
  involvedKind: string;
  involvedName: string;
  reason: string;
  message: string | null;
  type: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Upsert a batch of Kubernetes Events keyed by event_uid. The agent
 * polls cluster-wide warnings every collection cycle; re-firings of the
 * same event arrive with the same UID and a higher `count`, so we
 * UPDATE last_seen_at + count + message in place rather than
 * accumulating duplicate rows.
 */
function ingestEvents(db: Database.Database, clusterId: string, events: EventRecord[]): void {
  if (events.length === 0) return;

  const upsert = db.prepare(`
    INSERT INTO k8s_events
      (event_uid, cluster_id, namespace, involved_kind, involved_name,
       reason, message, type, count, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_uid) DO UPDATE SET
      count        = excluded.count,
      message      = excluded.message,
      last_seen_at = excluded.last_seen_at,
      -- Only refresh cluster_id/involved_* if they match — different
      -- cluster reusing a UID (astronomically unlikely) would be a bug.
      namespace    = excluded.namespace
  `);
  const upsertMany = db.transaction((items: EventRecord[]) => {
    for (const e of items) {
      upsert.run(
        e.eventUid, clusterId, e.namespace, e.involvedKind, e.involvedName,
        e.reason, e.message, e.type, e.count, e.firstSeenAt, e.lastSeenAt,
      );
    }
  });
  upsertMany(events);
  logger.info('ingest', `Upserted ${events.length} k8s events for cluster ${clusterId}`);
}

interface NodeConditionRecord {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string | null;
  message: string | null;
  lastHeartbeatAt: string | null;
  lastTransitionAt: string | null;
}

/**
 * Upsert the current set of k8s Node conditions for a host, keyed by
 * (host_id, type). This is current-state, not a time-series — each
 * collection cycle overwrites the prior row for the same condition.
 */
function ingestNodeConditions(db: Database.Database, hostId: string, conditions: NodeConditionRecord[]): void {
  if (conditions.length === 0) return;
  const upsert = db.prepare(`
    INSERT INTO node_conditions
      (host_id, type, status, reason, message, last_heartbeat_at, last_transition_at, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(host_id, type) DO UPDATE SET
      status             = excluded.status,
      reason             = excluded.reason,
      message            = excluded.message,
      last_heartbeat_at  = excluded.last_heartbeat_at,
      last_transition_at = excluded.last_transition_at,
      observed_at        = excluded.observed_at
  `);
  const upsertMany = db.transaction((items: NodeConditionRecord[]) => {
    for (const c of items) {
      upsert.run(hostId, c.type, c.status, c.reason, c.message, c.lastHeartbeatAt, c.lastTransitionAt);
    }
  });
  upsertMany(conditions);
}

module.exports = { ingestContainers, ingestDisk, ingestVolumes, ingestPvs, ingestPvcs, ingestEvents, ingestNodeConditions, ingestUpdates, upsertHost, ingestHost };
