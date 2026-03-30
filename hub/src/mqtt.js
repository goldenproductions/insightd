const mqtt = require('mqtt');
const logger = require('../../shared/utils/logger');
const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('./ingest');

let client = null;

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

    client.on('connect', () => {
      logger.info('mqtt', `Connected to ${config.mqttUrl}`);

      // Subscribe to all agent topics
      client.subscribe('insightd/+/collection', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to collection topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/collection');
      });

      client.subscribe('insightd/+/updates', { qos: 1 }, (err) => {
        if (err) logger.error('mqtt', 'Failed to subscribe to updates topic');
        else logger.info('mqtt', 'Subscribed to insightd/+/updates');
      });

      resolve(client);
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
  }));

  const disk = (payload.disk || []).map(d => ({
    mountPoint: d.mount_point,
    totalGb: d.total_gb,
    usedGb: d.used_gb,
    usedPercent: d.used_percent,
  }));

  upsertHost(db, hostId);
  if (containers.length > 0) ingestContainers(db, hostId, containers);
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

function disconnect() {
  if (client) {
    client.end();
    client = null;
  }
}

module.exports = { startSubscriber, disconnect };
