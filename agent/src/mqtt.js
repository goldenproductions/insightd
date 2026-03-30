const mqtt = require('mqtt');
const logger = require('../../shared/utils/logger');

let client = null;

function connect(config) {
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
      resolve(client);
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
