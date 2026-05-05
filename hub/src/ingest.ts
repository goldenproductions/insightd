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
  cpuLimitCores?: number | null;
  cpuLimitPercent?: number | null;
  memoryLimitMb?: number | null;
  cpuRequestCores?: number | null;
  memoryRequestMb?: number | null;
  lastOomKilledAt?: string | null;
  workloadKind?: string | null;
  podIp?: string | null;
  hostIp?: string | null;
  /** JSON-stringified PodCondition[] from the agent. */
  podConditions?: string | null;
  /** v48 — Proxmox VE guest identity. */
  guestType?: 'lxc' | 'qemu' | null;
  guestVmid?: number | null;
  guestUptimeSeconds?: number | null;
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
    INSERT INTO container_snapshots (host_id, container_name, container_id, status, cpu_percent, memory_mb, restart_count, network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status, health_check_output, labels, exit_code, size_rootfs_bytes, size_rw_bytes, cpu_limit_cores, cpu_limit_percent, memory_limit_mb, cpu_request_cores, memory_request_mb, last_oom_killed_at, workload_kind, pod_ip, host_ip, pod_conditions, guest_type, guest_vmid, guest_uptime_seconds, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        c.sizeRootfsBytes ?? null, c.sizeRwBytes ?? null,
        c.cpuLimitCores ?? null, c.cpuLimitPercent ?? null, c.memoryLimitMb ?? null,
        c.cpuRequestCores ?? null, c.memoryRequestMb ?? null,
        c.lastOomKilledAt ?? null,
        c.workloadKind ?? null, c.podIp ?? null, c.hostIp ?? null, c.podConditions ?? null,
        c.guestType ?? null, c.guestVmid ?? null, c.guestUptimeSeconds ?? null,
        batchAt);
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

interface IngressRecord {
  namespace: string;
  name: string;
  ingressClass?: string | null;
  hosts: string | string[];
  paths: string | unknown[];
  tlsHosts?: string | string[] | null;
  externalIp?: string | null;
  createdAt?: string | null;
  labels?: string | Record<string, string> | null;
}

/**
 * Registry-style ingest for k8s ingresses. Upsert by (cluster_id, namespace,
 * name) — the stable identity. After upserting a batch, stamp `removed_at`
 * on rows in this cluster_id whose `observed_at` is older than the batch
 * start time. Mirrors the `containers` registry pattern from PR #150 so that
 * promotion to an http_endpoint via `source_ingress_id` survives every
 * publisher cycle.
 */
function ingestIngresses(db: Database.Database, clusterId: string, ingresses: IngressRecord[]): void {
  const batchAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO k8s_ingresses
      (cluster_id, namespace, name, ingress_class, hosts, paths, tls_hosts,
       external_ip, created_at, labels, observed_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(cluster_id, namespace, name) DO UPDATE SET
      ingress_class = excluded.ingress_class,
      hosts         = excluded.hosts,
      paths         = excluded.paths,
      tls_hosts     = excluded.tls_hosts,
      external_ip   = excluded.external_ip,
      created_at    = excluded.created_at,
      labels        = excluded.labels,
      observed_at   = excluded.observed_at,
      removed_at    = NULL
  `);
  const stampRemoved = db.prepare(`
    UPDATE k8s_ingresses
       SET removed_at = ?
     WHERE cluster_id = ? AND removed_at IS NULL AND observed_at < ?
  `);

  const stringify = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v ?? []);

  const tx = db.transaction((items: IngressRecord[]) => {
    for (const i of items) {
      upsert.run(
        clusterId,
        i.namespace,
        i.name,
        i.ingressClass ?? null,
        stringify(i.hosts),
        stringify(i.paths),
        i.tlsHosts == null ? null : stringify(i.tlsHosts),
        i.externalIp ?? null,
        i.createdAt ?? null,
        i.labels == null ? null : (typeof i.labels === 'string' ? i.labels : JSON.stringify(i.labels)),
        batchAt,
      );
    }
    stampRemoved.run(batchAt, clusterId, batchAt);
  });
  tx(ingresses);
  logger.info('ingest', `Upserted ${ingresses.length} ingresses for cluster ${clusterId}`);
}

interface ServiceRecord {
  namespace: string;
  name: string;
  type: string;
  clusterIp: string | null;
  externalIps: string;            // JSON-stringified by the agent
  externalName: string | null;
  selector: string | null;        // JSON-stringified or null
  ports: string;                  // JSON-stringified
  createdAt: string | null;
  labels: string | null;          // JSON-stringified
}

/**
 * Registry-style ingest for k8s Services. Same upsert + stamp_removed pattern
 * as k8s_ingresses — services that vanish between publish cycles get
 * `removed_at` stamped, so the topology view drops them within one cycle.
 */
function ingestServices(db: Database.Database, clusterId: string, services: ServiceRecord[]): void {
  const batchAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO k8s_services
      (cluster_id, namespace, name, type, cluster_ip, external_ips, external_name,
       selector, ports, created_at, labels, observed_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(cluster_id, namespace, name) DO UPDATE SET
      type          = excluded.type,
      cluster_ip    = excluded.cluster_ip,
      external_ips  = excluded.external_ips,
      external_name = excluded.external_name,
      selector      = excluded.selector,
      ports         = excluded.ports,
      created_at    = excluded.created_at,
      labels        = excluded.labels,
      observed_at   = excluded.observed_at,
      removed_at    = NULL
  `);
  const stampRemoved = db.prepare(`
    UPDATE k8s_services
       SET removed_at = ?
     WHERE cluster_id = ? AND removed_at IS NULL AND observed_at < ?
  `);

  const tx = db.transaction((items: ServiceRecord[]) => {
    for (const s of items) {
      upsert.run(
        clusterId,
        s.namespace,
        s.name,
        s.type,
        s.clusterIp,
        s.externalIps,
        s.externalName,
        s.selector,
        s.ports,
        s.createdAt,
        s.labels,
        batchAt,
      );
    }
    stampRemoved.run(batchAt, clusterId, batchAt);
  });
  tx(services);
  logger.info('ingest', `Upserted ${services.length} services for cluster ${clusterId}`);
}

interface PendingPodRecord {
  namespace: string;
  podName: string;
  reason: string | null;
  message: string | null;
  podPhase: string;
  podCreatedAt: string | null;
  workloadKind: string | null;
  workloadName: string | null;
}

/**
 * Current-state UPSERT for pending pods. After upserting the batch, delete
 * any rows for this cluster_id whose last_seen_at is older than the batch
 * start time — those pods have either left Pending or no longer exist.
 *
 * first_seen_at is preserved across cycles (UPSERT doesn't touch it), so
 * the alert evaluator can age pods by their original observation time
 * regardless of how many publish cycles have elapsed.
 */
function ingestPendingPods(db: Database.Database, clusterId: string, pods: PendingPodRecord[]): void {
  const batchAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO pending_pods
      (cluster_id, namespace, pod_name, reason, message, pod_phase,
       pod_created_at, workload_kind, workload_name, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id, namespace, pod_name) DO UPDATE SET
      reason         = excluded.reason,
      message        = excluded.message,
      pod_phase      = excluded.pod_phase,
      pod_created_at = excluded.pod_created_at,
      workload_kind  = excluded.workload_kind,
      workload_name  = excluded.workload_name,
      last_seen_at   = excluded.last_seen_at
  `);
  const prune = db.prepare(`
    DELETE FROM pending_pods
     WHERE cluster_id = ? AND last_seen_at < ?
  `);

  const tx = db.transaction((items: PendingPodRecord[]) => {
    for (const p of items) {
      upsert.run(
        clusterId,
        p.namespace,
        p.podName,
        p.reason,
        p.message,
        p.podPhase,
        p.podCreatedAt,
        p.workloadKind,
        p.workloadName,
        batchAt,
        batchAt,
      );
    }
    prune.run(clusterId, batchAt);
  });
  tx(pods);
  logger.info('ingest', `Upserted ${pods.length} pending pods for cluster ${clusterId}`);
}

interface PodVolumeRecord {
  namespace: string;
  podUid: string;
  podName: string;
  volumeName: string;
  volumeType: string;
  targetName: string | null;
}

/**
 * Current-state UPSERT for pod volumes. Same prune-by-batchAt pattern as
 * pending_pods — when a pod or volume disappears from a later batch its
 * row is dropped within one cycle. The topology view joins this against
 * the existing `containers` registry to draw Workload→PVC edges.
 */
function ingestPodVolumes(db: Database.Database, clusterId: string, volumes: PodVolumeRecord[]): void {
  const batchAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO pod_volumes
      (cluster_id, namespace, pod_uid, pod_name, volume_name, volume_type, target_name, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id, namespace, pod_uid, volume_name) DO UPDATE SET
      pod_name    = excluded.pod_name,
      volume_type = excluded.volume_type,
      target_name = excluded.target_name,
      observed_at = excluded.observed_at
  `);
  const prune = db.prepare(`
    DELETE FROM pod_volumes
     WHERE cluster_id = ? AND observed_at < ?
  `);

  const tx = db.transaction((items: PodVolumeRecord[]) => {
    for (const v of items) {
      upsert.run(
        clusterId, v.namespace, v.podUid, v.podName,
        v.volumeName, v.volumeType, v.targetName, batchAt,
      );
    }
    prune.run(clusterId, batchAt);
  });
  tx(volumes);
  logger.info('ingest', `Upserted ${volumes.length} pod volumes for cluster ${clusterId}`);
}

interface WorkloadRolloutRecord {
  kind: string;
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  generation: number;
  observedGeneration: number;
  progressDeadlineExceeded: boolean;
}

/**
 * Current-state UPSERT for workload rollouts. Same prune-by-batchAt pattern
 * as pending_pods: when a workload disappears from a later batch (deleted)
 * its row is dropped within one cycle. first_seen_at is preserved across
 * cycles so the alert evaluator can age unavailable/degraded/stuck conditions
 * by their original observation time.
 *
 * Note: first_seen_at represents "when this row first appeared", not "when
 * this rollout entered an unhealthy state". The evaluator sees the current
 * counts and applies its own threshold; the unhealthy duration is implicit
 * in "row exists with these numbers and first_seen_at is old enough".
 */
function ingestWorkloadRollouts(db: Database.Database, clusterId: string, rollouts: WorkloadRolloutRecord[]): void {
  const batchAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO workload_rollouts
      (cluster_id, kind, namespace, name, desired, ready, updated,
       generation, observed_generation, progress_deadline_exceeded,
       first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id, kind, namespace, name) DO UPDATE SET
      desired                    = excluded.desired,
      ready                      = excluded.ready,
      updated                    = excluded.updated,
      generation                 = excluded.generation,
      observed_generation        = excluded.observed_generation,
      progress_deadline_exceeded = excluded.progress_deadline_exceeded,
      last_seen_at               = excluded.last_seen_at
  `);
  const prune = db.prepare(`
    DELETE FROM workload_rollouts
     WHERE cluster_id = ? AND last_seen_at < ?
  `);

  const tx = db.transaction((items: WorkloadRolloutRecord[]) => {
    for (const r of items) {
      upsert.run(
        clusterId, r.kind, r.namespace, r.name,
        r.desired, r.ready, r.updated,
        r.generation, r.observedGeneration,
        r.progressDeadlineExceeded ? 1 : 0,
        batchAt, batchAt,
      );
    }
    prune.run(clusterId, batchAt);
  });
  tx(rollouts);
  logger.info('ingest', `Upserted ${rollouts.length} workload rollouts for cluster ${clusterId}`);
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

interface PveStorageRecord {
  storageName: string;
  storageType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  active: number;
  shared: number;
}

interface PveZfsRecord {
  poolName: string;
  health: string;
  sizeBytes: number | null;
  allocBytes: number | null;
  fragmentation: number | null;
  dedupRatio: number | null;
  lastScrubAt: string | null;
}

interface PveClusterRecord {
  clusterName: string;
  quorate: number;
  totalNodes: number;
  onlineNodes: number;
}

/**
 * v49 — per-cycle storage usage per PVE node. Append-only, queries take the
 * latest row per (host, storage). Mirrors the disk_snapshots shape rather
 * than upserting — keeps history available for trends without bloating the
 * row count beyond what daily prune handles.
 */
function ingestPveStorage(db: Database.Database, hostId: string, items: PveStorageRecord[]): void {
  const insert = db.prepare(`
    INSERT INTO pve_storage_snapshots
      (host_id, storage_name, storage_type, total_bytes, used_bytes, active, shared, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMany = db.transaction((rows: PveStorageRecord[]) => {
    for (const r of rows) {
      insert.run(hostId, r.storageName, r.storageType, r.totalBytes, r.usedBytes, r.active, r.shared);
    }
  });
  if (items.length > 0) insertMany(items);
}

/**
 * v49 — ZFS pool health. Upserted on (host_id, pool_name) so each cycle
 * overwrites the previous row — the table holds *current* state, not
 * history. Anomalies in pool health are surfaced as alerts, not trends.
 */
function ingestPveZfs(db: Database.Database, hostId: string, items: PveZfsRecord[]): void {
  const upsert = db.prepare(`
    INSERT INTO pve_zfs_pools
      (host_id, pool_name, health, size_bytes, alloc_bytes, fragmentation, dedup_ratio, last_scrub_at, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(host_id, pool_name) DO UPDATE SET
      health        = excluded.health,
      size_bytes    = excluded.size_bytes,
      alloc_bytes   = excluded.alloc_bytes,
      fragmentation = excluded.fragmentation,
      dedup_ratio   = excluded.dedup_ratio,
      last_scrub_at = excluded.last_scrub_at,
      observed_at   = excluded.observed_at
  `);
  // Pools that disappear since last cycle are pruned so the alert evaluator
  // doesn't see ghost-DEGRADED rows for a pool that's been zpool-destroyed.
  const presentNames = items.map(i => i.poolName);
  const placeholders = presentNames.map(() => '?').join(',');
  const deleteMissing = presentNames.length > 0
    ? db.prepare(`DELETE FROM pve_zfs_pools WHERE host_id = ? AND pool_name NOT IN (${placeholders})`)
    : db.prepare('DELETE FROM pve_zfs_pools WHERE host_id = ?');
  const upsertMany = db.transaction((rows: PveZfsRecord[]) => {
    for (const r of rows) {
      upsert.run(hostId, r.poolName, r.health, r.sizeBytes, r.allocBytes, r.fragmentation, r.dedupRatio, r.lastScrubAt);
    }
    if (presentNames.length > 0) deleteMissing.run(hostId, ...presentNames);
    else deleteMissing.run(hostId);
  });
  upsertMany(items);
}

/**
 * v49 — cluster quorum + node count. Single row per cluster, upserted —
 * every PVE node publishes the same row each cycle and last write wins.
 * Hub stores nothing on standalone PVE installs (publishPveCluster
 * short-circuits when the agent's collectClusterStatus returns null).
 */
function ingestPveCluster(db: Database.Database, status: PveClusterRecord): void {
  db.prepare(`
    INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes, observed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cluster_name) DO UPDATE SET
      quorate      = excluded.quorate,
      total_nodes  = excluded.total_nodes,
      online_nodes = excluded.online_nodes,
      observed_at  = excluded.observed_at
  `).run(status.clusterName, status.quorate, status.totalNodes, status.onlineNodes);
}

module.exports = { ingestContainers, ingestDisk, ingestVolumes, ingestPvs, ingestPvcs, ingestEvents, ingestIngresses, ingestServices, ingestPendingPods, ingestPodVolumes, ingestWorkloadRollouts, ingestNodeConditions, ingestUpdates, upsertHost, ingestHost, ingestPveStorage, ingestPveZfs, ingestPveCluster };
