import mqtt = require('mqtt');
import logger = require('../../shared/utils/logger');
import type { MqttClient, IClientOptions } from 'mqtt';
import type { ContainerRuntime } from './runtime/types';
import { LogsUnavailableError } from './runtime/types';
import { DockerRuntime } from './runtime/docker';

interface AgentConfig {
  hostId: string;
  mqttUrl: string;
  mqttUser?: string;
  mqttPass?: string;
  logLines?: number;
  logMaxLines?: number;
}

interface CollectionData {
  containers: Array<{
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
    labels?: Record<string, string>;
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
    podConditions?: Array<{ type: string; status: string; reason?: string | null; message?: string | null }> | null;
    guestType?: 'lxc' | 'qemu' | null;
    guestVmid?: number | null;
    guestUuid?: string | null;
    guestPrimaryMac?: string | null;
    guestUptimeSeconds?: number | null;
  }>;
  disk: Array<{
    mountPoint: string;
    totalGb: number;
    usedGb: number;
    usedPercent: number;
  }>;
  volumes?: Array<{
    name: string;
    driver: string;
    mountpoint: string | null;
    sizeBytes: number | null;
    refCount: number | null;
    createdAt: string | null;
    labels: Record<string, string>;
  }>;
  host?: {
    cpuPercent?: number | null;
    memory?: { totalMb?: number; usedMb?: number; availableMb?: number; swapTotalMb?: number; swapUsedMb?: number } | null;
    load?: { load1?: number; load5?: number; load15?: number } | null;
    uptimeSeconds?: number | null;
  } | null;
  gpu?: {
    gpus?: Array<{ utilizationPercent?: number; memoryUsedMb?: number; memoryTotalMb?: number; temperatureCelsius?: number | null }>;
  } | null;
  temperature?: {
    sensors?: Array<{ temperatureCelsius?: number }>;
  } | null;
  diskIO?: { readBytesPerSec?: number; writeBytesPerSec?: number } | null;
  networkIO?: { rxBytesPerSec?: number; txBytesPerSec?: number } | null;
  nodeConditions?: Array<{
    type: string;
    status: 'True' | 'False' | 'Unknown';
    reason?: string | null;
    message?: string | null;
    lastHeartbeatTime?: string | null;
    lastTransitionTime?: string | null;
  }> | null;
  runtimeName?: string;
  hostGroup?: string;
  /** Free-form labels the agent reports about itself. Currently only used
   *  by the Proxmox identity bridge (`insightd.proxmox.guest=<node>/<vmid>`)
   *  but the field is generic so future labels (rack, datacenter, role)
   *  don't need a payload-version bump. */
  hostLabels?: Record<string, string>;
}

interface UpdateData {
  containerName: string;
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  hasUpdate: boolean;
}

let client: MqttClient | null = null;
let runtimeInstance: ContainerRuntime | null = null;

function connect(config: AgentConfig, runtime: ContainerRuntime): Promise<MqttClient> {
  runtimeInstance = runtime;
  return new Promise((resolve, reject) => {
    const opts: IClientOptions = {
      clientId: `insightd-agent-${config.hostId}`,
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

      const logRequestTopic = `insightd/${config.hostId}/logs/request`;
      const updateRequestTopic = `insightd/${config.hostId}/update/request`;
      client!.subscribe(logRequestTopic, { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to log request topic');
        else logger.info('mqtt', `Subscribed to ${logRequestTopic}`);
      });
      client!.subscribe(updateRequestTopic, { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to update request topic');
        else logger.info('mqtt', `Subscribed to ${updateRequestTopic}`);
      });
      const actionRequestTopic = `insightd/${config.hostId}/action/request`;
      client!.subscribe(actionRequestTopic, { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to action request topic');
        else logger.info('mqtt', `Subscribed to ${actionRequestTopic}`);
      });
      const checkUpdatesTopic = `insightd/${config.hostId}/check-updates/request`;
      client!.subscribe(checkUpdatesTopic, { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to check-updates topic');
        else logger.info('mqtt', `Subscribed to ${checkUpdatesTopic}`);
      });

      if (!connected) {
        connected = true;
        resolve(client!);
      }
    });

    client.on('message', async (topic: string, message: Buffer) => {
      // Handle manual "check for image updates" requests
      if (topic.endsWith('/check-updates/request')) {
        if (!runtimeInstance || !runtimeInstance.supportsUpdateChecks) {
          logger.info('mqtt', 'Ignoring check-updates request — not supported for this runtime');
          return;
        }
        try {
          const req = JSON.parse(message.toString());
          if (req.timestamp) {
            const age = Date.now() - new Date(req.timestamp).getTime();
            if (age > 60000) {
              logger.info('mqtt', `Ignoring stale check-updates request (${Math.round(age / 1000)}s old)`);
              return;
            }
          }
          logger.info('mqtt', 'Manual image update check requested');
          const updates = await runtimeInstance.checkImageUpdates();
          if (updates && updates.length > 0) {
            await publishUpdates(config.hostId, updates);
          }
          logger.info('mqtt', `Manual check complete — ${updates.length} images checked`);
        } catch (err) {
          logger.error('mqtt', `Check-updates failed: ${(err as Error).message}`);
        }
        return;
      }

      // Handle update requests (Docker-only: self/hub update flow)
      if (topic.endsWith('/update/request')) {
        const responseTopic = `insightd/${config.hostId}/update/response`;
        try {
          const req = JSON.parse(message.toString());

          if (req.timestamp) {
            const age = Date.now() - new Date(req.timestamp).getTime();
            if (age > 60000) {
              logger.info('mqtt', `Ignoring stale update request (${Math.round(age / 1000)}s old)`);
              return;
            }
          }

          logger.info('mqtt', `Update request: target=${req.target}, image=${req.image}`);

          if (!(runtimeInstance instanceof DockerRuntime)) {
            client!.publish(responseTopic, JSON.stringify({
              requestId: req.requestId,
              status: 'failed',
              error: `Updates are only supported for Docker runtime (current: ${runtimeInstance?.name})`,
            }), { qos: 1 });
            return;
          }

          const { performUpdate } = require('./updater') as { performUpdate: (docker: any, target: string, image: string) => Promise<{ status: string; message: string }> };
          const result = await performUpdate(runtimeInstance.getClient(), req.target, req.image);

          client!.publish(responseTopic, JSON.stringify({ requestId: req.requestId, ...result }), { qos: 1 });
        } catch (err) {
          logger.error('mqtt', `Update failed: ${(err as Error).message}`);
          try {
            const req = JSON.parse(message.toString());
            client!.publish(responseTopic, JSON.stringify({ requestId: req.requestId, status: 'failed', error: (err as Error).message }), { qos: 1 });
          } catch { /* can't even parse the request */ }
        }
        return;
      }

      // Handle container action requests
      if (topic.endsWith('/action/request')) {
        const responseTopic = `insightd/${config.hostId}/action/response`;
        try {
          const req = JSON.parse(message.toString());

          if (req.timestamp) {
            const age = Date.now() - new Date(req.timestamp).getTime();
            if (age > 60000) {
              logger.info('mqtt', `Ignoring stale action request (${Math.round(age / 1000)}s old)`);
              return;
            }
          }

          logger.info('mqtt', `Action request: ${req.action} on ${req.containerName}`);

          if (!runtimeInstance) throw new Error('Runtime not initialized');
          if (!runtimeInstance.supportsActions) {
            throw new Error(`Container actions not supported for ${runtimeInstance.name} runtime`);
          }

          const result = await runtimeInstance.performAction(req.containerName, req.action);
          client!.publish(responseTopic, JSON.stringify({ requestId: req.requestId, ...result }), { qos: 1 });
        } catch (err) {
          logger.error('mqtt', `Action failed: ${(err as Error).message}`);
          try {
            const req = JSON.parse(message.toString());
            client!.publish(responseTopic, JSON.stringify({ requestId: req.requestId, status: 'failed', error: (err as Error).message }), { qos: 1 });
          } catch { /* can't parse */ }
        }
        return;
      }

      if (!topic.endsWith('/logs/request')) return;
      try {
        const req = JSON.parse(message.toString());
        const maxLines = config.logMaxLines || 1000;
        const lines = Math.min(req.lines || config.logLines || 100, maxLines);
        logger.info('mqtt', `Log request for ${req.containerId} (${lines} lines)`);

        if (!runtimeInstance) throw new Error('Runtime not initialized');
        const logs = await runtimeInstance.fetchLogs(req.containerId, {
          lines,
          stream: req.stream || 'both',
        });

        const responseTopic = `insightd/${config.hostId}/logs/response`;
        const payload = JSON.stringify({ requestId: req.requestId, logs, error: null });
        client!.publish(responseTopic, payload, { qos: 1 });
      } catch (err) {
        const responseTopic = `insightd/${config.hostId}/logs/response`;
        const req = JSON.parse(message.toString());
        // Documented "no logs here" cases (PVE REST mode, QEMU from hypervisor):
        // ship the message to the hub as an `unavailable` hint so the UI can
        // render a calm empty state, and log at info — these aren't failures.
        if (err instanceof LogsUnavailableError) {
          logger.info('mqtt', `Log request unavailable for ${req.containerId}: ${err.message}`);
          const payload = JSON.stringify({ requestId: req.requestId, logs: [], unavailable: err.message, error: null });
          client!.publish(responseTopic, payload, { qos: 1 });
          return;
        }
        logger.error('mqtt', `Log request failed: ${(err as Error).message}`);
        const payload = JSON.stringify({ requestId: req.requestId, logs: null, error: (err as Error).message });
        client!.publish(responseTopic, payload, { qos: 1 });
      }
    });

    client.on('error', (err: Error) => {
      logger.error('mqtt', `Connection error: ${err.message}`);
      reject(err);
    });

    client.on('offline', () => {
      logger.warn('mqtt', 'Broker offline — messages will queue');
    });

    client.on('reconnect', () => {
      logger.info('mqtt', 'Reconnecting...');
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!client!.connected) {
        reject(new Error('MQTT connection timeout'));
      }
    }, 10000);
  });
}

/**
 * Map a ContainerInfo-like object into the snake_case JSON shape published
 * over MQTT. Exported so tests can pin the round-trip behaviour against the
 * hub's `payloadContainerToSnapshot` — every field needs both ends wired.
 */
export function containerInfoToPayload(c: CollectionData['containers'][number]): Record<string, any> {
  return {
    name: c.name,
    id: c.id,
    status: c.status,
    cpu_percent: c.cpuPercent ?? null,
    memory_mb: c.memoryMb ?? null,
    restart_count: c.restartCount,
    network_rx_bytes: c.networkRxBytes ?? null,
    network_tx_bytes: c.networkTxBytes ?? null,
    blkio_read_bytes: c.blkioReadBytes ?? null,
    blkio_write_bytes: c.blkioWriteBytes ?? null,
    health_status: c.healthStatus ?? null,
    health_check_output: c.healthCheckOutput ?? null,
    labels: JSON.stringify(c.labels || {}),
    exit_code: c.exitCode ?? null,
    size_rootfs_bytes: c.sizeRootfsBytes ?? null,
    size_rw_bytes: c.sizeRwBytes ?? null,
    cpu_limit_cores: c.cpuLimitCores ?? null,
    cpu_limit_percent: c.cpuLimitPercent ?? null,
    memory_limit_mb: c.memoryLimitMb ?? null,
    cpu_request_cores: c.cpuRequestCores ?? null,
    memory_request_mb: c.memoryRequestMb ?? null,
    last_oom_killed_at: c.lastOomKilledAt ?? null,
    workload_kind: c.workloadKind ?? null,
    pod_ip: c.podIp ?? null,
    host_ip: c.hostIp ?? null,
    pod_conditions: c.podConditions ? JSON.stringify(c.podConditions) : null,
    guest_type: c.guestType ?? null,
    guest_vmid: c.guestVmid ?? null,
    guest_uuid: c.guestUuid ?? null,
    guest_primary_mac: c.guestPrimaryMac ?? null,
    guest_uptime_seconds: c.guestUptimeSeconds ?? null,
  };
}

function publishCollection(hostId: string, data: CollectionData): Promise<void> {
  const topic = `insightd/${hostId}/collection`;
  const { VERSION } = require('./config') as { VERSION: string };
  const msg: Record<string, any> = {
    version: 5,
    host_id: hostId,
    agent_version: VERSION,
    runtime_type: data.runtimeName ?? 'docker',
    host_group: data.hostGroup || null,
    host_labels: data.hostLabels && Object.keys(data.hostLabels).length > 0
      ? data.hostLabels
      : null,
    collected_at: new Date().toISOString(),
    containers: data.containers.map(containerInfoToPayload),
    disk: data.disk.map(d => ({
      mount_point: d.mountPoint,
      total_gb: d.totalGb,
      used_gb: d.usedGb,
      used_percent: d.usedPercent,
    })),
    volumes: (data.volumes ?? []).map(v => ({
      name: v.name,
      driver: v.driver,
      mountpoint: v.mountpoint,
      size_bytes: v.sizeBytes,
      ref_count: v.refCount,
      created_at: v.createdAt,
      labels: JSON.stringify(v.labels || {}),
    })),
  };
  if (data.host) {
    msg.host = {
      cpu_percent: data.host.cpuPercent ?? null,
      memory_total_mb: data.host.memory?.totalMb ?? null,
      memory_used_mb: data.host.memory?.usedMb ?? null,
      memory_available_mb: data.host.memory?.availableMb ?? null,
      swap_total_mb: data.host.memory?.swapTotalMb ?? null,
      swap_used_mb: data.host.memory?.swapUsedMb ?? null,
      load_1: data.host.load?.load1 ?? null,
      load_5: data.host.load?.load5 ?? null,
      load_15: data.host.load?.load15 ?? null,
      uptime_seconds: data.host.uptimeSeconds ?? null,
      gpu_utilization_percent: data.gpu?.gpus?.[0]?.utilizationPercent ?? null,
      gpu_memory_used_mb: data.gpu?.gpus?.[0]?.memoryUsedMb ?? null,
      gpu_memory_total_mb: data.gpu?.gpus?.[0]?.memoryTotalMb ?? null,
      gpu_temperature_celsius: data.gpu?.gpus?.[0]?.temperatureCelsius ?? null,
      cpu_temperature_celsius: data.temperature?.sensors?.[0]?.temperatureCelsius ?? null,
      disk_read_bytes_per_sec: data.diskIO?.readBytesPerSec ?? null,
      disk_write_bytes_per_sec: data.diskIO?.writeBytesPerSec ?? null,
      net_rx_bytes_per_sec: data.networkIO?.rxBytesPerSec ?? null,
      net_tx_bytes_per_sec: data.networkIO?.txBytesPerSec ?? null,
    };
  }
  if (data.nodeConditions && data.nodeConditions.length > 0) {
    msg.node_conditions = data.nodeConditions.map(c => ({
      type: c.type,
      status: c.status,
      reason: c.reason ?? null,
      message: c.message ?? null,
      last_heartbeat_at: c.lastHeartbeatTime ?? null,
      last_transition_at: c.lastTransitionTime ?? null,
    }));
  }
  const payload = JSON.stringify(msg);

  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish to ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published collection (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface PvPayloadItem {
  name: string;
  phase: string;
  capacityBytes: number | null;
  accessModes: string[];
  reclaimPolicy: string | null;
  storageClass: string | null;
  volumeMode: string | null;
  claimRef: { namespace: string; name: string } | null;
  csiDriver: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

interface PvcPayloadItem {
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
  labels: Record<string, string>;
}

function publishPvs(clusterId: string, publisherHostId: string, pvs: PvPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/pvs`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: pvs.map(p => ({
      name: p.name,
      phase: p.phase,
      capacity_bytes: p.capacityBytes,
      access_modes: p.accessModes,
      reclaim_policy: p.reclaimPolicy,
      storage_class: p.storageClass,
      volume_mode: p.volumeMode,
      claim_namespace: p.claimRef?.namespace ?? null,
      claim_name: p.claimRef?.name ?? null,
      csi_driver: p.csiDriver,
      created_at: p.createdAt,
      labels: JSON.stringify(p.labels || {}),
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${pvs.length} PVs for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function publishPvcs(clusterId: string, publisherHostId: string, pvcs: PvcPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/pvcs`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: pvcs.map(p => ({
      namespace: p.namespace,
      name: p.name,
      phase: p.phase,
      storage_class: p.storageClass,
      request_bytes: p.requestBytes,
      capacity_bytes: p.capacityBytes,
      access_modes: p.accessModes,
      volume_name: p.volumeName,
      volume_mode: p.volumeMode,
      created_at: p.createdAt,
      labels: JSON.stringify(p.labels || {}),
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${pvcs.length} PVCs for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface EventPayloadItem {
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

function publishEvents(clusterId: string, publisherHostId: string, events: EventPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/events`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: events.map(e => ({
      event_uid: e.eventUid,
      namespace: e.namespace,
      involved_kind: e.involvedKind,
      involved_name: e.involvedName,
      reason: e.reason,
      message: e.message,
      type: e.type,
      count: e.count,
      first_seen_at: e.firstSeenAt,
      last_seen_at: e.lastSeenAt,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${events.length} events for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface IngressPayloadItem {
  namespace: string;
  name: string;
  ingressClass: string | null;
  hosts: string[];
  paths: Array<{
    host: string;
    path: string;
    pathType: string | null;
    serviceName: string | null;
    servicePort: number | string | null;
  }>;
  tlsHosts: string[];
  externalIp: string | null;
  createdAt: string | null;
  labels: Record<string, string>;
}

function publishIngresses(clusterId: string, publisherHostId: string, ingresses: IngressPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/ingresses`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: ingresses.map(i => ({
      namespace: i.namespace,
      name: i.name,
      ingress_class: i.ingressClass,
      hosts: JSON.stringify(i.hosts),
      paths: JSON.stringify(i.paths),
      tls_hosts: JSON.stringify(i.tlsHosts),
      external_ip: i.externalIp,
      created_at: i.createdAt,
      labels: JSON.stringify(i.labels || {}),
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${ingresses.length} ingresses for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface PendingPodPayloadItem {
  namespace: string;
  podName: string;
  reason: string | null;
  message: string | null;
  podPhase: string;
  podCreatedAt: string | null;
  workloadKind: string | null;
  workloadName: string | null;
}

function publishPendingPods(clusterId: string, publisherHostId: string, pods: PendingPodPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/pending-pods`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: pods.map(p => ({
      namespace: p.namespace,
      pod_name: p.podName,
      reason: p.reason,
      message: p.message,
      pod_phase: p.podPhase,
      pod_created_at: p.podCreatedAt,
      workload_kind: p.workloadKind,
      workload_name: p.workloadName,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${pods.length} pending pods for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface ServicePayloadItem {
  namespace: string;
  name: string;
  type: string;
  clusterIp: string | null;
  externalIps: string[];
  externalName: string | null;
  selector: Record<string, string> | null;
  ports: Array<{
    name: string | null;
    port: number;
    targetPort: number | string | null;
    protocol: string | null;
    nodePort: number | null;
  }>;
  createdAt: string | null;
  labels: Record<string, string>;
}

function publishServices(clusterId: string, publisherHostId: string, services: ServicePayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/services`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: services.map(s => ({
      namespace: s.namespace,
      name: s.name,
      type: s.type,
      cluster_ip: s.clusterIp,
      external_ips: JSON.stringify(s.externalIps),
      external_name: s.externalName,
      selector: s.selector ? JSON.stringify(s.selector) : null,
      ports: JSON.stringify(s.ports),
      created_at: s.createdAt,
      labels: JSON.stringify(s.labels || {}),
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${services.length} services for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface PodVolumePayloadItem {
  namespace: string;
  podUid: string;
  podName: string;
  volumeName: string;
  volumeType: string;
  targetName: string | null;
}

function publishPodVolumes(clusterId: string, publisherHostId: string, volumes: PodVolumePayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/pod-volumes`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: volumes.map(v => ({
      namespace: v.namespace,
      pod_uid: v.podUid,
      pod_name: v.podName,
      volume_name: v.volumeName,
      volume_type: v.volumeType,
      target_name: v.targetName,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${volumes.length} pod volumes for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface WorkloadRolloutPayloadItem {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  generation: number;
  observedGeneration: number;
  progressDeadlineExceeded: boolean;
}

function publishWorkloadRollouts(clusterId: string, publisherHostId: string, rollouts: WorkloadRolloutPayloadItem[]): Promise<void> {
  const topic = `insightd/_cluster_${clusterId}/workload-rollouts`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    cluster_id: clusterId,
    publisher_host_id: publisherHostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: rollouts.map(r => ({
      kind: r.kind,
      namespace: r.namespace,
      name: r.name,
      desired: r.desired,
      ready: r.ready,
      updated: r.updated,
      generation: r.generation,
      observed_generation: r.observedGeneration,
      progress_deadline_exceeded: r.progressDeadlineExceeded,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${rollouts.length} workload rollouts for cluster ${clusterId} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface PveStoragePayloadItem {
  storageName: string;
  storageType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  active: boolean;
  shared: boolean;
}

interface PveZfsPayloadItem {
  poolName: string;
  health: string;
  sizeBytes: number | null;
  allocBytes: number | null;
  fragmentation: number | null;
  dedupRatio: number | null;
  lastScrubAt: string | null;
}

interface PveClusterPayload {
  clusterName: string;
  quorate: boolean;
  totalNodes: number;
  onlineNodes: number;
}

function publishPveStorage(hostId: string, items: PveStoragePayloadItem[]): Promise<void> {
  const topic = `insightd/${hostId}/pve-storage`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: items.map(i => ({
      storage_name: i.storageName,
      storage_type: i.storageType,
      total_bytes: i.totalBytes,
      used_bytes: i.usedBytes,
      active: i.active ? 1 : 0,
      shared: i.shared ? 1 : 0,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${items.length} PVE storage pools (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function publishPveZfs(hostId: string, items: PveZfsPayloadItem[]): Promise<void> {
  const topic = `insightd/${hostId}/pve-zfs`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: items.map(i => ({
      pool_name: i.poolName,
      health: i.health,
      size_bytes: i.sizeBytes,
      alloc_bytes: i.allocBytes,
      fragmentation: i.fragmentation,
      dedup_ratio: i.dedupRatio,
      last_scrub_at: i.lastScrubAt,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${items.length} ZFS pools (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function publishPveCluster(hostId: string, status: PveClusterPayload | null): Promise<void> {
  // Standalone PVE host (no /cluster/status row of type='cluster') — nothing
  // to report. The hub never alerts on quorum for hosts that never publish.
  if (!status) return Promise.resolve();
  const topic = `insightd/${hostId}/pve-cluster`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    cluster_name: status.clusterName,
    quorate: status.quorate ? 1 : 0,
    total_nodes: status.totalNodes,
    online_nodes: status.onlineNodes,
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published cluster status quorate=${status.quorate} (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

interface PveGuestSnapshotPayloadItem {
  guestVmid: number;
  snapshotCount: number;
  newestAt: string | null;
  oldestAt: string | null;
}

interface PveGuestBackupPayloadItem {
  guestVmid: number;
  lastBackupAt: string | null;
  lastStatus: 'OK' | 'FAILED' | 'NEVER';
  storageTarget: string | null;
}

function publishPveGuestSnapshots(hostId: string, items: PveGuestSnapshotPayloadItem[]): Promise<void> {
  const topic = `insightd/${hostId}/pve-guest-snapshots`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: items.map(i => ({
      guest_vmid: i.guestVmid,
      snapshot_count: i.snapshotCount,
      newest_at: i.newestAt,
      oldest_at: i.oldestAt,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${items.length} PVE guest snapshot summaries (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function publishPveBackups(hostId: string, items: PveGuestBackupPayloadItem[]): Promise<void> {
  const topic = `insightd/${hostId}/pve-backups`;
  const { VERSION } = require('./config') as { VERSION: string };
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    agent_version: VERSION,
    collected_at: new Date().toISOString(),
    items: items.map(i => ({
      guest_vmid: i.guestVmid,
      last_backup_at: i.lastBackupAt,
      last_status: i.lastStatus,
      storage_target: i.storageTarget,
    })),
  });
  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('mqtt', `Failed to publish ${topic}: ${err.message}`);
        reject(err);
      } else {
        logger.info('mqtt', `Published ${items.length} PVE backup summaries (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function publishUpdates(hostId: string, updates: UpdateData[]): Promise<void> {
  const topic = `insightd/${hostId}/updates`;
  const payload = JSON.stringify({
    version: 1,
    host_id: hostId,
    checked_at: new Date().toISOString(),
    updates: updates.map(u => ({
      container_name: u.containerName,
      image: u.image,
      local_digest: u.localDigest,
      remote_digest: u.remoteDigest,
      has_update: u.hasUpdate,
    })),
  });

  return new Promise((resolve, reject) => {
    client!.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) reject(err);
      else {
        logger.info('mqtt', `Published updates (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function disconnect(): void {
  if (client) {
    client.end();
    client = null;
  }
}

module.exports = { connect, publishCollection, publishUpdates, publishPvs, publishPvcs, publishEvents, publishIngresses, publishPendingPods, publishServices, publishPodVolumes, publishWorkloadRollouts, publishPveStorage, publishPveZfs, publishPveCluster, publishPveGuestSnapshots, publishPveBackups, disconnect, containerInfoToPayload };
