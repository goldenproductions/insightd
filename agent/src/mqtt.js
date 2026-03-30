const mqtt = require('mqtt');
const logger = require('../../shared/utils/logger');
const { fetchContainerLogs } = require('../../shared/utils/docker-logs');

let client = null;
let dockerInstance = null;

function connect(config, docker) {
  dockerInstance = docker;
  return new Promise((resolve, reject) => {
    const opts = {
      clientId: `insightd-agent-${config.hostId}`,
      clean: false, // persistent session for QoS 1
      reconnectPeriod: 5000,
    };
    if (config.mqttUser) {
      opts.username = config.mqttUser;
      opts.password = config.mqttPass;
    }

    client = mqtt.connect(config.mqttUrl, opts);

    client.on('connect', () => {
      logger.info('mqtt', `Connected to ${config.mqttUrl}`);

      // Subscribe to log requests
      const logRequestTopic = `insightd/${config.hostId}/logs/request`;
      client.subscribe(logRequestTopic, { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to log request topic');
        else logger.info('mqtt', `Subscribed to ${logRequestTopic}`);
      });

      resolve(client);
    });

    client.on('message', async (topic, message) => {
      if (!topic.endsWith('/logs/request')) return;
      try {
        const req = JSON.parse(message.toString());
        const maxLines = config.logMaxLines || 1000;
        const lines = Math.min(req.lines || config.logLines || 100, maxLines);
        logger.info('mqtt', `Log request for ${req.containerId} (${lines} lines)`);

        const logs = await fetchContainerLogs(dockerInstance, req.containerId, {
          lines,
          stream: req.stream || 'both',
        });

        const responseTopic = `insightd/${config.hostId}/logs/response`;
        const payload = JSON.stringify({ requestId: req.requestId, logs, error: null });
        client.publish(responseTopic, payload, { qos: 1 });
      } catch (err) {
        logger.error('mqtt', `Log request failed: ${err.message}`);
        const responseTopic = `insightd/${config.hostId}/logs/response`;
        const req = JSON.parse(message.toString());
        const payload = JSON.stringify({ requestId: req.requestId, logs: null, error: err.message });
        client.publish(responseTopic, payload, { qos: 1 });
      }
    });

    client.on('error', (err) => {
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
      if (!client.connected) {
        reject(new Error('MQTT connection timeout'));
      }
    }, 10000);
  });
}

function publishCollection(hostId, data) {
  const topic = `insightd/${hostId}/collection`;
  const msg = {
    version: 2,
    host_id: hostId,
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
    };
  }
  const payload = JSON.stringify(msg);

  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (err) => {
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

function publishUpdates(hostId, updates) {
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
    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) reject(err);
      else {
        logger.info('mqtt', `Published updates (${payload.length} bytes)`);
        resolve();
      }
    });
  });
}

function disconnect() {
  if (client) {
    client.end();
    client = null;
  }
}

module.exports = { connect, publishCollection, publishUpdates, disconnect };
