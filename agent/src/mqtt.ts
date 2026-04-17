import mqtt = require('mqtt');
import logger = require('../../shared/utils/logger');
import type { MqttClient, IClientOptions } from 'mqtt';
import type { ContainerRuntime } from './runtime/types';
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
  }>;
  disk: Array<{
    mountPoint: string;
    totalGb: number;
    usedGb: number;
    usedPercent: number;
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
  runtimeName?: string;
  hostGroup?: string;
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
        logger.error('mqtt', `Log request failed: ${(err as Error).message}`);
        const responseTopic = `insightd/${config.hostId}/logs/response`;
        const req = JSON.parse(message.toString());
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

function publishCollection(hostId: string, data: CollectionData): Promise<void> {
  const topic = `insightd/${hostId}/collection`;
  const { VERSION } = require('./config') as { VERSION: string };
  const msg: Record<string, any> = {
    version: 3,
    host_id: hostId,
    agent_version: VERSION,
    runtime_type: data.runtimeName ?? 'docker',
    host_group: data.hostGroup || null,
    collected_at: new Date().toISOString(),
    containers: data.containers.map(c => ({
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
    })),
    disk: data.disk.map(d => ({
      mount_point: d.mountPoint,
      total_gb: d.totalGb,
      used_gb: d.usedGb,
      used_percent: d.usedPercent,
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

module.exports = { connect, publishCollection, publishUpdates, disconnect };
