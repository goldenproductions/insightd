const crypto = require('crypto');
const mqtt = require('mqtt');
const logger = require('../../shared/utils/logger');
const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('./ingest');

let client = null;
const pendingLogRequests = new Map();

function startSubscriber(db, config) {
  return new Promise((resolve, reject) => {
    const opts = {
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
      client.subscribe('insightd/+/collection', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to collection topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/collection');
      });

      client.subscribe('insightd/+/updates', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to updates topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/updates');
      });

      client.subscribe('insightd/+/logs/response', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to logs response topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/logs/response');
      });

      client.subscribe('insightd/+/update/response', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to update response topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/update/response');
      });

      if (!connected) {
        connected = true;
        resolve(client);
      }
    });

    client.on('message', (topic, message) => {
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
        }
      } catch (err) {
        logger.error('mqtt', `Failed to process message on ${topic}: ${err.message}`);
      }
    });

    client.on('error', (err) => {
      logger.error('mqtt', `Connection error: ${err.message}`);
      reject(err);
    });

    client.on('offline', () => {
      logger.warn('mqtt', 'Broker offline');
    });

    setTimeout(() => {
      if (!client.connected) reject(new Error('MQTT connection timeout'));
    }, 10000);
  });
}

function handleCollection(db, hostId, payload) {
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
    labels: c.labels || null,
  }));

  const disk = (payload.disk || []).map(d => ({
    mountPoint: d.mount_point,
    totalGb: d.total_gb,
    usedGb: d.used_gb,
    usedPercent: d.used_percent,
  }));

  upsertHost(db, hostId, payload.agent_version || null);
  if (containers.length > 0) {
    ingestContainers(db, hostId, containers);
    const { autoAssignGroups } = require('./web/group-queries');
    autoAssignGroups(db, hostId, containers);
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

function handleUpdates(db, hostId, payload) {
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

function handleLogResponse(payload) {
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

function requestContainerLogs(hostId, containerId, options = {}) {
  const requestId = crypto.randomUUID();
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

    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        clearTimeout(timer);
        pendingLogRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

// --- Update request/response ---
const pendingUpdateRequests = new Map();

function handleUpdateResponse(payload) {
  const pending = pendingUpdateRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingUpdateRequests.delete(payload.requestId);
  pending.resolve({ status: payload.status, message: payload.message, error: payload.error || null });
}

function requestAgentUpdate(hostId, target, image) {
  const requestId = crypto.randomUUID();
  const timeoutMs = 120000; // 2 minutes (image pull can be slow)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingUpdateRequests.delete(requestId);
      reject(new Error('Update request timed out — agent may be offline or pull is slow'));
    }, timeoutMs);

    pendingUpdateRequests.set(requestId, { resolve, reject, timer });

    const topic = `insightd/${hostId}/update/request`;
    const payload = JSON.stringify({ requestId, target, image });
    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        clearTimeout(timer);
        pendingUpdateRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

function disconnect() {
  // Reject all pending log requests
  for (const [id, pending] of pendingLogRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('MQTT disconnecting'));
  }
  pendingLogRequests.clear();

  if (client) {
    client.end();
    client = null;
  }
}

module.exports = { startSubscriber, disconnect, requestContainerLogs, requestAgentUpdate };
