const crypto = require('crypto');
import mqtt = require('mqtt');
import logger = require('../../shared/utils/logger');
import type Database from 'better-sqlite3';
import type { MqttClient, IClientOptions } from 'mqtt';

const { ingestContainers, ingestDisk, ingestVolumes, ingestPvs, ingestPvcs, ingestEvents, ingestIngresses, ingestServices, ingestPendingPods, ingestNodeConditions, ingestUpdates, upsertHost, ingestHost } = require('./ingest') as {
  ingestContainers: (db: Database.Database, hostId: string, containers: any[]) => void;
  ingestDisk: (db: Database.Database, hostId: string, disk: any[]) => void;
  ingestVolumes: (db: Database.Database, hostId: string, volumes: any[]) => void;
  ingestPvs: (db: Database.Database, clusterId: string, pvs: any[]) => void;
  ingestPvcs: (db: Database.Database, clusterId: string, pvcs: any[]) => void;
  ingestEvents: (db: Database.Database, clusterId: string, events: any[]) => void;
  ingestIngresses: (db: Database.Database, clusterId: string, ingresses: any[]) => void;
  ingestServices: (db: Database.Database, clusterId: string, services: any[]) => void;
  ingestPendingPods: (db: Database.Database, clusterId: string, pods: any[]) => void;
  ingestNodeConditions: (db: Database.Database, hostId: string, conditions: any[]) => void;
  ingestUpdates: (db: Database.Database, hostId: string, updates: any[]) => void;
  upsertHost: (db: Database.Database, hostId: string, agentVersion?: string | null, runtimeType?: string, hostGroup?: string | null) => void;
  ingestHost: (db: Database.Database, hostId: string, metrics: any) => void;
};

interface MqttConfig {
  mqttUrl: string;
  mqttUser?: string;
  mqttPass?: string;
}

interface LogRequestOptions {
  timeoutMs?: number;
  lines?: number;
  stream?: string;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CollectionPayload {
  containers?: Array<{
    name: string;
    id: string;
    status: string;
    cpu_percent?: number | null;
    memory_mb?: number | null;
    restart_count: number;
    network_rx_bytes?: number | null;
    network_tx_bytes?: number | null;
    blkio_read_bytes?: number | null;
    blkio_write_bytes?: number | null;
    health_status?: string | null;
    health_check_output?: string | null;
    labels?: Record<string, string> | null;
    exit_code?: number | null;
    size_rootfs_bytes?: number | null;
    size_rw_bytes?: number | null;
    cpu_limit_cores?: number | null;
    cpu_limit_percent?: number | null;
    memory_limit_mb?: number | null;
    last_oom_killed_at?: string | null;
    workload_kind?: string | null;
    pod_ip?: string | null;
    host_ip?: string | null;
    /** JSON-stringified PodCondition[] — hub stores as text, frontend parses. */
    pod_conditions?: string | null;
  }>;
  disk?: Array<{
    mount_point: string;
    total_gb: number;
    used_gb: number;
    used_percent: number;
  }>;
  volumes?: Array<{
    name: string;
    driver: string;
    mountpoint: string | null;
    size_bytes: number | null;
    ref_count: number | null;
    created_at: string | null;
    labels: string | null;
  }>;
  host?: {
    cpu_percent?: number | null;
    memory_total_mb?: number | null;
    memory_used_mb?: number | null;
    memory_available_mb?: number | null;
    swap_total_mb?: number | null;
    swap_used_mb?: number | null;
    load_1?: number | null;
    load_5?: number | null;
    load_15?: number | null;
    uptime_seconds?: number | null;
    gpu_utilization_percent?: number | null;
    gpu_memory_used_mb?: number | null;
    gpu_memory_total_mb?: number | null;
    gpu_temperature_celsius?: number | null;
    cpu_temperature_celsius?: number | null;
    disk_read_bytes_per_sec?: number | null;
    disk_write_bytes_per_sec?: number | null;
    net_rx_bytes_per_sec?: number | null;
    net_tx_bytes_per_sec?: number | null;
  };
  node_conditions?: Array<{
    type: string;
    status: string;
    reason?: string | null;
    message?: string | null;
    last_heartbeat_at?: string | null;
    last_transition_at?: string | null;
  }>;
  agent_version?: string;
  runtime_type?: string;
  host_group?: string | null;
}

interface UpdatesPayload {
  updates?: Array<{
    container_name: string;
    image: string;
    local_digest: string;
    remote_digest: string;
    has_update: boolean;
  }>;
}

interface LogResponsePayload {
  requestId: string;
  error?: string;
  logs?: any[];
}

interface UpdateResponsePayload {
  requestId: string;
  status: string;
  message: string;
  error?: string | null;
}

interface ActionResponsePayload {
  requestId: string;
  status: string;
  message: string;
  error?: string | null;
}

let client: MqttClient | null = null;
const pendingLogRequests = new Map<string, PendingRequest<any[]>>();

function startSubscriber(db: Database.Database, config: MqttConfig): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const opts: IClientOptions = {
      clientId: 'insightd-hub',
      clean: false,
      reconnectPeriod: 5000,
    };
    if (config.mqttUser) {
      opts.username = config.mqttUser;
      opts.password = config.mqttPass;
    }

    client = mqtt.connect(config.mqttUrl, opts);

    let connected = false;
    client.on('connect', () => {
      logger.info('mqtt', `${connected ? 'Reconnected' : 'Connected'} to ${config.mqttUrl}`);

      // Subscribe to all agent topics
      client!.subscribe('insightd/+/collection', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to collection topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/collection');
      });

      client!.subscribe('insightd/+/updates', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to updates topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/updates');
      });

      client!.subscribe('insightd/+/pvs', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to pvs topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/pvs');
      });

      client!.subscribe('insightd/+/pvcs', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to pvcs topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/pvcs');
      });

      client!.subscribe('insightd/+/events', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to events topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/events');
      });

      client!.subscribe('insightd/+/ingresses', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to ingresses topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/ingresses');
      });

      client!.subscribe('insightd/+/pending-pods', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to pending-pods topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/pending-pods');
      });

      client!.subscribe('insightd/+/services', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to services topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/services');
      });

      client!.subscribe('insightd/+/logs/response', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to logs response topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/logs/response');
      });

      client!.subscribe('insightd/+/update/response', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to update response topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/update/response');
      });

      client!.subscribe('insightd/+/action/response', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to action response topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/action/response');
      });

      if (!connected) {
        connected = true;
        resolve(client!);
      }
    });

    client.on('message', (topic: string, message: Buffer) => {
      try {
        const payload = JSON.parse(message.toString());
        const parts = topic.split('/');
        const hostId = parts[1];
        const type = parts[2];

        // Cluster-scoped topics use `insightd/_cluster_<id>/pvs|pvcs`. The
        // `_cluster_` prefix keeps them out of per-host routing: hostId here
        // is really the cluster_id wrapped in a sentinel, which the PV/PVC
        // handlers unwrap.
        if (hostId.startsWith('_cluster_')) {
          const clusterId = hostId.slice('_cluster_'.length);
          if (type === 'pvs')           { handlePvs(db, clusterId, payload); return; }
          if (type === 'pvcs')          { handlePvcs(db, clusterId, payload); return; }
          if (type === 'events')        { handleEvents(db, clusterId, payload); return; }
          if (type === 'ingresses')     { handleIngresses(db, clusterId, payload); return; }
          if (type === 'pending-pods')  { handlePendingPods(db, clusterId, payload); return; }
          if (type === 'services')      { handleServices(db, clusterId, payload); return; }
        }

        if (type === 'collection') {
          handleCollection(db, hostId, payload);
        } else if (type === 'updates') {
          handleUpdates(db, hostId, payload);
        } else if (type === 'logs' && parts[3] === 'response') {
          handleLogResponse(payload);
        } else if (type === 'update' && parts[3] === 'response') {
          handleUpdateResponse(payload);
        } else if (type === 'action' && parts[3] === 'response') {
          handleActionResponse(payload);
        }
      } catch (err) {
        logger.error('mqtt', `Failed to process message on ${topic}: ${(err as Error).message}`);
      }
    });

    client.on('error', (err: Error) => {
      logger.error('mqtt', `Connection error: ${err.message}`);
      reject(err);
    });

    client.on('offline', () => {
      logger.warn('mqtt', 'Broker offline');
    });

    setTimeout(() => {
      if (!client!.connected) reject(new Error('MQTT connection timeout'));
    }, 10000);
  });
}

/**
 * Map a snake_case MQTT container payload entry into the camelCase shape
 * the hub's ingest layer expects. Exported so tests can pin the round-trip
 * behaviour — every field the agent publishes must land here, otherwise
 * the column silently stays NULL in the DB (caught the hard way for
 * last_oom_killed_at).
 */
export function payloadContainerToSnapshot(c: NonNullable<CollectionPayload['containers']>[number]): any {
  return {
    name: c.name,
    id: c.id,
    status: c.status,
    cpuPercent: c.cpu_percent,
    memoryMb: c.memory_mb,
    restartCount: c.restart_count,
    networkRxBytes: c.network_rx_bytes,
    networkTxBytes: c.network_tx_bytes,
    blkioReadBytes: c.blkio_read_bytes,
    blkioWriteBytes: c.blkio_write_bytes,
    healthStatus: c.health_status,
    healthCheckOutput: c.health_check_output ?? null,
    labels: c.labels || null,
    exitCode: c.exit_code ?? null,
    sizeRootfsBytes: c.size_rootfs_bytes ?? null,
    sizeRwBytes: c.size_rw_bytes ?? null,
    cpuLimitCores: c.cpu_limit_cores ?? null,
    cpuLimitPercent: c.cpu_limit_percent ?? null,
    memoryLimitMb: c.memory_limit_mb ?? null,
    lastOomKilledAt: c.last_oom_killed_at ?? null,
    workloadKind: c.workload_kind ?? null,
    podIp: c.pod_ip ?? null,
    hostIp: c.host_ip ?? null,
    podConditions: c.pod_conditions ?? null,
  };
}

function handleCollection(db: Database.Database, hostId: string, payload: CollectionPayload): void {
  const containers = (payload.containers || []).map(payloadContainerToSnapshot);

  // Detect containers transitioning to unhealthy — pre-warm the log cache for diagnosis
  const unhealthyTransitions: Array<{ name: string; id: string }> = [];
  if (containers.length > 0) {
    const prevStatuses = db.prepare(`
      SELECT cs.container_name, cs.health_status
      FROM container_snapshots cs
      INNER JOIN (
        SELECT container_name, MAX(collected_at) as max_at
        FROM container_snapshots WHERE host_id = ?
        GROUP BY container_name
      ) latest ON cs.container_name = latest.container_name AND cs.collected_at = latest.max_at
      WHERE cs.host_id = ?
    `).all(hostId, hostId) as Array<{ container_name: string; health_status: string | null }>;
    const prevMap = new Map(prevStatuses.map(p => [p.container_name, p.health_status]));
    for (const c of containers) {
      const prev = prevMap.get(c.name);
      if (c.healthStatus === 'unhealthy' && prev !== 'unhealthy') {
        unhealthyTransitions.push({ name: c.name, id: c.id });
      }
    }
  }

  const disk = (payload.disk || []).map(d => ({
    mountPoint: d.mount_point,
    totalGb: d.total_gb,
    usedGb: d.used_gb,
    usedPercent: d.used_percent,
  }));

  const volumes = (payload.volumes || []).map(v => ({
    name: v.name,
    driver: v.driver,
    mountpoint: v.mountpoint ?? null,
    sizeBytes: v.size_bytes ?? null,
    refCount: v.ref_count ?? null,
    createdAt: v.created_at ?? null,
    labels: v.labels ?? null,
  }));

  upsertHost(db, hostId, payload.agent_version || null, payload.runtime_type || 'docker', payload.host_group ?? null);
  if (containers.length > 0) {
    ingestContainers(db, hostId, containers);

    // Fire background log fetches for containers that just went unhealthy
    if (unhealthyTransitions.length > 0) {
      const { fetchLogsBackground, resolveImageKey } = require('./insights/diagnosis/logCache');
      for (const { name, id } of unhealthyTransitions) {
        logger.info('diagnosis', `Pre-warming logs for ${hostId}/${name} (health transitioned to unhealthy)`);
        const image = resolveImageKey(db, hostId, name);
        fetchLogsBackground(
          hostId,
          name,
          id,
          async (h: string, cid: string, opts: any) => requestContainerLogs(h, cid, opts),
          { db, image },
        );
      }
    }
  }
  if (disk.length > 0) ingestDisk(db, hostId, disk);

  // Volumes: agents that don't support the listing (k8s, older versions) will
  // simply not include the field — skip silently rather than wipe state.
  if (payload.volumes !== undefined) ingestVolumes(db, hostId, volumes);

  // Host metrics (v2 payloads)
  if (payload.host) {
    const h = payload.host;
    ingestHost(db, hostId, {
      cpuPercent: h.cpu_percent,
      memory: {
        totalMb: h.memory_total_mb,
        usedMb: h.memory_used_mb,
        availableMb: h.memory_available_mb,
        swapTotalMb: h.swap_total_mb,
        swapUsedMb: h.swap_used_mb,
      },
      load: { load1: h.load_1, load5: h.load_5, load15: h.load_15 },
      uptimeSeconds: h.uptime_seconds,
      gpuUtilizationPercent: h.gpu_utilization_percent ?? null,
      gpuMemoryUsedMb: h.gpu_memory_used_mb ?? null,
      gpuMemoryTotalMb: h.gpu_memory_total_mb ?? null,
      gpuTemperatureCelsius: h.gpu_temperature_celsius ?? null,
      cpuTemperatureCelsius: h.cpu_temperature_celsius ?? null,
      diskReadBytesPerSec: h.disk_read_bytes_per_sec ?? null,
      diskWriteBytesPerSec: h.disk_write_bytes_per_sec ?? null,
      netRxBytesPerSec: h.net_rx_bytes_per_sec ?? null,
      netTxBytesPerSec: h.net_tx_bytes_per_sec ?? null,
    });
  }

  // Node conditions (v4 payloads) — only present for k8s hosts
  if (payload.node_conditions && payload.node_conditions.length > 0) {
    const conditions = payload.node_conditions.map(c => ({
      type: c.type,
      status: (c.status === 'True' || c.status === 'False') ? c.status : 'Unknown',
      reason: c.reason ?? null,
      message: c.message ?? null,
      lastHeartbeatAt: c.last_heartbeat_at ?? null,
      lastTransitionAt: c.last_transition_at ?? null,
    }));
    ingestNodeConditions(db, hostId, conditions);
  }

  logger.info('mqtt', `Ingested from ${hostId}: ${containers.length} containers, ${disk.length} disk mounts${payload.host ? ', host metrics' : ''}`);
}

interface PvPayload {
  items?: Array<{
    name: string;
    phase: string;
    capacity_bytes?: number | null;
    access_modes?: string[];
    reclaim_policy?: string | null;
    storage_class?: string | null;
    volume_mode?: string | null;
    claim_namespace?: string | null;
    claim_name?: string | null;
    csi_driver?: string | null;
    created_at?: string | null;
    labels?: string | null;
  }>;
}

interface PvcPayload {
  items?: Array<{
    namespace: string;
    name: string;
    phase: string;
    storage_class?: string | null;
    request_bytes?: number | null;
    capacity_bytes?: number | null;
    access_modes?: string[];
    volume_name?: string | null;
    volume_mode?: string | null;
    created_at?: string | null;
    labels?: string | null;
  }>;
}

interface EventsPayload {
  items?: Array<{
    event_uid: string;
    namespace: string | null;
    involved_kind: string;
    involved_name: string;
    reason: string;
    message: string | null;
    type: string;
    count: number;
    first_seen_at: string;
    last_seen_at: string;
  }>;
}

function handlePvs(db: Database.Database, clusterId: string, payload: PvPayload): void {
  const pvs = (payload.items || []).map(p => ({
    name: p.name,
    phase: p.phase,
    capacityBytes: p.capacity_bytes ?? null,
    accessModes: p.access_modes ?? [],
    reclaimPolicy: p.reclaim_policy ?? null,
    storageClass: p.storage_class ?? null,
    volumeMode: p.volume_mode ?? null,
    claimNamespace: p.claim_namespace ?? null,
    claimName: p.claim_name ?? null,
    csiDriver: p.csi_driver ?? null,
    createdAt: p.created_at ?? null,
    labels: p.labels ?? null,
  }));
  ingestPvs(db, clusterId, pvs);
  logger.info('mqtt', `Ingested ${pvs.length} PVs for cluster ${clusterId}`);
}

function handlePvcs(db: Database.Database, clusterId: string, payload: PvcPayload): void {
  const pvcs = (payload.items || []).map(p => ({
    namespace: p.namespace,
    name: p.name,
    phase: p.phase,
    storageClass: p.storage_class ?? null,
    requestBytes: p.request_bytes ?? null,
    capacityBytes: p.capacity_bytes ?? null,
    accessModes: p.access_modes ?? [],
    volumeName: p.volume_name ?? null,
    volumeMode: p.volume_mode ?? null,
    createdAt: p.created_at ?? null,
    labels: p.labels ?? null,
  }));
  ingestPvcs(db, clusterId, pvcs);
  logger.info('mqtt', `Ingested ${pvcs.length} PVCs for cluster ${clusterId}`);
}

interface IngressesPayload {
  items?: Array<{
    namespace: string;
    name: string;
    ingress_class?: string | null;
    hosts: string;
    paths: string;
    tls_hosts?: string | null;
    external_ip?: string | null;
    created_at?: string | null;
    labels?: string | null;
  }>;
}

function handleIngresses(db: Database.Database, clusterId: string, payload: IngressesPayload): void {
  const ingresses = (payload.items || []).map(i => ({
    namespace: i.namespace,
    name: i.name,
    ingressClass: i.ingress_class ?? null,
    hosts: i.hosts,
    paths: i.paths,
    tlsHosts: i.tls_hosts ?? null,
    externalIp: i.external_ip ?? null,
    createdAt: i.created_at ?? null,
    labels: i.labels ?? null,
  }));
  ingestIngresses(db, clusterId, ingresses);
  logger.info('mqtt', `Ingested ${ingresses.length} ingresses for cluster ${clusterId}`);
}

interface PendingPodsPayload {
  items?: Array<{
    namespace: string;
    pod_name: string;
    reason?: string | null;
    message?: string | null;
    pod_phase: string;
    pod_created_at?: string | null;
    workload_kind?: string | null;
    workload_name?: string | null;
  }>;
}

function handlePendingPods(db: Database.Database, clusterId: string, payload: PendingPodsPayload): void {
  const pods = (payload.items || []).map(p => ({
    namespace: p.namespace,
    podName: p.pod_name,
    reason: p.reason ?? null,
    message: p.message ?? null,
    podPhase: p.pod_phase,
    podCreatedAt: p.pod_created_at ?? null,
    workloadKind: p.workload_kind ?? null,
    workloadName: p.workload_name ?? null,
  }));
  ingestPendingPods(db, clusterId, pods);
  logger.info('mqtt', `Ingested ${pods.length} pending pods for cluster ${clusterId}`);
}

interface ServicesPayload {
  items?: Array<{
    namespace: string;
    name: string;
    type: string;
    cluster_ip?: string | null;
    external_ips?: string | null;        // JSON-stringified by the agent
    external_name?: string | null;
    selector?: string | null;            // JSON-stringified or null
    ports: string;                       // JSON-stringified
    created_at?: string | null;
    labels?: string | null;
  }>;
}

function handleServices(db: Database.Database, clusterId: string, payload: ServicesPayload): void {
  const services = (payload.items || []).map(s => ({
    namespace: s.namespace,
    name: s.name,
    type: s.type,
    clusterIp: s.cluster_ip ?? null,
    externalIps: s.external_ips ?? '[]',
    externalName: s.external_name ?? null,
    selector: s.selector ?? null,
    ports: s.ports,
    createdAt: s.created_at ?? null,
    labels: s.labels ?? null,
  }));
  ingestServices(db, clusterId, services);
  logger.info('mqtt', `Ingested ${services.length} services for cluster ${clusterId}`);
}

function handleEvents(db: Database.Database, clusterId: string, payload: EventsPayload): void {
  const events = (payload.items || []).map(e => ({
    eventUid: e.event_uid,
    namespace: e.namespace ?? null,
    involvedKind: e.involved_kind,
    involvedName: e.involved_name,
    reason: e.reason,
    message: e.message ?? null,
    type: e.type,
    count: e.count,
    firstSeenAt: e.first_seen_at,
    lastSeenAt: e.last_seen_at,
  }));
  if (events.length > 0) ingestEvents(db, clusterId, events);
  logger.info('mqtt', `Ingested ${events.length} events for cluster ${clusterId}`);
}

function handleUpdates(db: Database.Database, hostId: string, payload: UpdatesPayload): void {
  const updates = (payload.updates || []).map(u => ({
    containerName: u.container_name,
    image: u.image,
    localDigest: u.local_digest,
    remoteDigest: u.remote_digest,
    hasUpdate: u.has_update,
  }));

  upsertHost(db, hostId);
  if (updates.length > 0) ingestUpdates(db, hostId, updates);

  logger.info('mqtt', `Ingested updates from ${hostId}: ${updates.length} checks`);
}

function handleLogResponse(payload: LogResponsePayload): void {
  const pending = pendingLogRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingLogRequests.delete(payload.requestId);
  if (payload.error) {
    pending.reject(new Error(payload.error));
  } else {
    pending.resolve(payload.logs || []);
  }
}

function requestContainerLogs(hostId: string, containerId: string, options: LogRequestOptions = {}): Promise<any[]> {
  const requestId: string = crypto.randomUUID();
  const timeoutMs = options.timeoutMs || 15000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLogRequests.delete(requestId);
      reject(new Error('Log request timed out — agent may be offline'));
    }, timeoutMs);

    pendingLogRequests.set(requestId, { resolve, reject, timer });

    const topic = `insightd/${hostId}/logs/request`;
    const payload = JSON.stringify({
      requestId,
      containerId,
      lines: options.lines || 100,
      stream: options.stream || 'both',
    });

    client!.publish(topic, payload, { qos: 1 }, (err?: Error) => {
      if (err) {
        clearTimeout(timer);
        pendingLogRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

// --- Update request/response ---
const pendingUpdateRequests = new Map<string, PendingRequest<{ status: string; message: string; error: string | null }>>();

function handleUpdateResponse(payload: UpdateResponsePayload): void {
  const pending = pendingUpdateRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingUpdateRequests.delete(payload.requestId);
  pending.resolve({ status: payload.status, message: payload.message, error: payload.error || null });
}

function requestAgentUpdate(hostId: string, target: string, image: string): Promise<{ status: string; message: string; error: string | null }> {
  const requestId: string = crypto.randomUUID();
  const timeoutMs = 120000; // 2 minutes (image pull can be slow)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingUpdateRequests.delete(requestId);
      reject(new Error('No response from agent. Check that INSIGHTD_ALLOW_UPDATES=true is set and the agent is running v0.2.0+.'));
    }, timeoutMs);

    pendingUpdateRequests.set(requestId, { resolve, reject, timer });

    const topic = `insightd/${hostId}/update/request`;
    const payload = JSON.stringify({ requestId, target, image, timestamp: new Date().toISOString() });
    logger.info('mqtt', `Publishing update request to ${topic}: target=${target}, image=${image}`);
    if (!client || !client.connected) {
      clearTimeout(timer);
      pendingUpdateRequests.delete(requestId);
      reject(new Error('MQTT client not connected'));
      return;
    }
    client.publish(topic, payload, { qos: 1 }, (err?: Error) => {
      if (err) {
        logger.error('mqtt', `Failed to publish update request: ${err.message}`);
        clearTimeout(timer);
        pendingUpdateRequests.delete(requestId);
        reject(err);
      } else {
        logger.info('mqtt', `Update request published to ${topic}`);
      }
    });
  });
}

// --- Container action request/response ---
const pendingActionRequests = new Map<string, PendingRequest<{ status: string; message: string; error: string | null }>>();

function handleActionResponse(payload: ActionResponsePayload): void {
  const pending = pendingActionRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingActionRequests.delete(payload.requestId);
  pending.resolve({ status: payload.status, message: payload.message, error: payload.error || null });
}

function requestContainerAction(hostId: string, containerName: string, action: string): Promise<{ status: string; message: string; error: string | null }> {
  const requestId: string = crypto.randomUUID();
  const timeoutMs = 30000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingActionRequests.delete(requestId);
      reject(new Error('No response from agent. Check that INSIGHTD_ALLOW_ACTIONS=true is set and the agent is online.'));
    }, timeoutMs);

    pendingActionRequests.set(requestId, { resolve, reject, timer });

    const topic = `insightd/${hostId}/action/request`;
    const payload = JSON.stringify({ requestId, containerName, action, timestamp: new Date().toISOString() });
    logger.info('mqtt', `Publishing action request to ${topic}: ${action} on ${containerName}`);
    if (!client || !client.connected) {
      clearTimeout(timer);
      pendingActionRequests.delete(requestId);
      reject(new Error('MQTT client not connected'));
      return;
    }
    client.publish(topic, payload, { qos: 1 }, (err?: Error) => {
      if (err) {
        logger.error('mqtt', `Failed to publish action request: ${err.message}`);
        clearTimeout(timer);
        pendingActionRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

// --- Manual image update check ---

function requestUpdateCheck(db: Database.Database, onlineThresholdMinutes: number): { hostsNotified: number } {
  if (!client || !client.connected) {
    throw new Error('MQTT client not connected');
  }
  const hosts = db.prepare(`
    SELECT DISTINCT host_id FROM hosts
    WHERE runtime_type = 'docker'
      AND last_seen > datetime('now', '-' || ? || ' minutes')
  `).all(onlineThresholdMinutes) as Array<{ host_id: string }>;

  const timestamp = new Date().toISOString();
  for (const h of hosts) {
    const topic = `insightd/${h.host_id}/check-updates/request`;
    client.publish(topic, JSON.stringify({ timestamp }), { qos: 1 });
  }
  logger.info('mqtt', `Sent check-updates request to ${hosts.length} host(s)`);
  return { hostsNotified: hosts.length };
}

function disconnect(): void {
  // Reject all pending log requests
  for (const [id, pending] of pendingLogRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('MQTT disconnecting'));
  }
  pendingLogRequests.clear();

  for (const [id, pending] of pendingActionRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('MQTT disconnecting'));
  }
  pendingActionRequests.clear();

  if (client) {
    client.end();
    client = null;
  }
}

module.exports = { startSubscriber, disconnect, requestContainerLogs, requestAgentUpdate, requestContainerAction, requestUpdateCheck, payloadContainerToSnapshot };
