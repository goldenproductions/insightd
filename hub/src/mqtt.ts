const crypto = require('crypto');
import mqtt = require('mqtt');
import logger = require('../../shared/utils/logger');
import type Database from 'better-sqlite3';
import type { MqttClient, IClientOptions } from 'mqtt';

const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('./ingest') as {
  ingestContainers: (db: Database.Database, hostId: string, containers: any[]) => void;
  ingestDisk: (db: Database.Database, hostId: string, disk: any[]) => void;
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
  }>;
  disk?: Array<{
    mount_point: string;
    total_gb: number;
    used_gb: number;
    used_percent: number;
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

function handleCollection(db: Database.Database, hostId: string, payload: CollectionPayload): void {
  const containers = (payload.containers || []).map(c => ({
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
  }));

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

  upsertHost(db, hostId, payload.agent_version || null, payload.runtime_type || 'docker', payload.host_group ?? null);
  if (containers.length > 0) {
    ingestContainers(db, hostId, containers);
    const { autoAssignGroups } = require('./web/group-queries');
    autoAssignGroups(db, hostId, containers);

    // Fire background log fetches for containers that just went unhealthy
    if (unhealthyTransitions.length > 0) {
      const { fetchLogsBackground } = require('./insights/diagnosis/logCache');
      for (const { name, id } of unhealthyTransitions) {
        logger.info('diagnosis', `Pre-warming logs for ${hostId}/${name} (health transitioned to unhealthy)`);
        fetchLogsBackground(hostId, name, id, async (h: string, cid: string, opts: any) => {
          return await requestContainerLogs(h, cid, opts);
        });
      }
    }
  }
  if (disk.length > 0) ingestDisk(db, hostId, disk);

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

  logger.info('mqtt', `Ingested from ${hostId}: ${containers.length} containers, ${disk.length} disk mounts${payload.host ? ', host metrics' : ''}`);
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

module.exports = { startSubscriber, disconnect, requestContainerLogs, requestAgentUpdate, requestContainerAction, requestUpdateCheck };
