const fs = require('fs');
const cron = require('node-cron');
const logger = require('../../shared/utils/logger');
const { safeCollect } = require('../../shared/utils/errors');
const { publishCollection, publishUpdates } = require('./mqtt');

function startAgentScheduler(docker, config) {
  const { collectContainers } = require('./collectors/containers');
  const { collectResources } = require('./collectors/resources');
  const { collectDisk } = require('./collectors/disk');
  const { collectHost } = require('./collectors/host');
  const { collectGpu } = require('./collectors/gpu');
  const { collectTemperature } = require('./collectors/temperature');
  const { collectDiskIO } = require('./collectors/disk-io');
  const { collectNetworkIO } = require('./collectors/network-io');
  const { checkUpdates } = require('./collectors/updates');

  async function runCollection() {
    logger.info('scheduler', 'Starting collection cycle');

    let containers = await safeCollect('containers', () => collectContainers(docker));
    if (containers) {
      containers = await safeCollect('resources', () => collectResources(docker, containers));
    }

    const disk = await safeCollect('disk', () => collectDisk(config)) || [];
    const host = await safeCollect('host', () => collectHost(config));
    const gpu = await safeCollect('gpu', () => collectGpu());
    const temperature = await safeCollect('temperature', () => collectTemperature(config));
    const diskIO = await safeCollect('disk-io', () => collectDiskIO(config));
    const networkIO = await safeCollect('network-io', () => collectNetworkIO(config));

    logger.info('scheduler', 'Collection cycle complete');

    // Publish to MQTT
    if (containers) {
      await safeCollect('mqtt-publish', () =>
        publishCollection(config.hostId, { containers, disk, host, gpu, temperature, diskIO, networkIO })
      );
    }

    // Write health file for Docker HEALTHCHECK
    try { fs.writeFileSync('/tmp/insightd-healthy', ''); } catch { /* ignore */ }
  }

  // Run immediately
  runCollection();

  // Schedule collection
  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  cron.schedule(collectCron, runCollection, { timezone: config.timezone });
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

  // Schedule update checks
  cron.schedule(config.updateCheckCron, async () => {
    logger.info('scheduler', 'Checking for image updates...');
    const updates = await safeCollect('updates', () => checkUpdates(docker));
    if (updates && updates.length > 0) {
      await safeCollect('mqtt-updates', () =>
        publishUpdates(config.hostId, updates)
      );
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
}

module.exports = { startAgentScheduler };
