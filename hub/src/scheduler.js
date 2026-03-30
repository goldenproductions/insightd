const cron = require('node-cron');
const logger = require('../../shared/utils/logger');
const { safeCollect } = require('../../shared/utils/errors');
const { pruneOldData } = require('./db/schema');
const { getEffectiveConfig } = require('./db/settings');

const scheduledTasks = [];

function stopScheduler() {
  for (const task of scheduledTasks) task.stop();
  scheduledTasks.length = 0;
  logger.info('scheduler', 'All scheduled tasks stopped');
}

/**
 * Hub scheduler — runs digest and alert jobs.
 * In hub mode: only digest + alerts (data comes via MQTT).
 */
function startHubScheduler(db, config) {
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');

  // Schedule digest delivery
  scheduledTasks.push(cron.schedule(config.digestCron, async () => {
    logger.info('scheduler', 'Building digest...');
    const liveConfig = getEffectiveConfig(db, config);
    const data = await safeCollect('digest-build', () => buildDigest(db, liveConfig));
    if (data) {
      await safeCollect('digest-send', () => sendDigest(data, liveConfig));
      pruneOldData(db);
    }
  }, { timezone: config.timezone }));
  logger.info('scheduler', `Digest scheduled: ${config.digestCron} (${config.timezone})`);

  // Schedule alert evaluation — always run, check enabled at runtime (hot-reload)
  const alertCron = `*/${Math.max(1, config.collectIntervalMinutes || 5)} * * * *`;
  scheduledTasks.push(cron.schedule(alertCron, async () => {
    const liveConfig = getEffectiveConfig(db, config);
    if (!liveConfig.alerts.enabled) return;
    const { runAlerts } = require('./alerts/evaluator');
    await safeCollect('alerts', () => runAlerts(db, liveConfig));
  }, { timezone: config.timezone }));
  logger.info('scheduler', `Alert evaluation scheduled: ${alertCron}`);
}

/**
 * Standalone scheduler — collection + digest + alerts (no MQTT).
 * This is backwards compatible with the original single-container mode.
 */
function startStandaloneScheduler(db, docker, config) {
  const { collectContainers } = require('../../src/collectors/containers');
  const { collectResources } = require('../../src/collectors/resources');
  const { collectDisk } = require('../../src/collectors/disk');
  const { collectHost } = require('../../src/collectors/host');
  const { checkUpdates } = require('../../src/collectors/updates');
  const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('./ingest');
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');
  const hostId = config.hostId || 'local';

  let alerts = null;
  if (config.alerts.enabled) {
    const { runAlerts } = require('./alerts/evaluator');
    alerts = { runAlerts };
  }

  async function runCollection() {
    logger.info('scheduler', 'Starting collection cycle');

    let containers = await safeCollect('containers', () => collectContainers(docker));
    if (containers) {
      containers = await safeCollect('resources', () => collectResources(docker, containers));
      safeCollect('ingest-containers', () => {
        ingestContainers(db, hostId, containers);
        upsertHost(db, hostId);
      });
    }

    const diskResults = await safeCollect('disk', () => collectDisk(config)) || [];
    if (diskResults.length > 0) {
      safeCollect('ingest-disk', () => ingestDisk(db, hostId, diskResults));
    }

    const hostMetrics = await safeCollect('host', () => collectHost(config));
    if (hostMetrics) {
      safeCollect('ingest-host', () => ingestHost(db, hostId, hostMetrics));
    }

    logger.info('scheduler', 'Collection cycle complete');

    const liveConfig = getEffectiveConfig(db, config);
    if (liveConfig.alerts.enabled) {
      await safeCollect('alerts', () => require('./alerts/evaluator').runAlerts(db, liveConfig));
    }
  }

  runCollection();

  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  scheduledTasks.push(cron.schedule(collectCron, runCollection, { timezone: config.timezone }));
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

  scheduledTasks.push(cron.schedule(config.digestCron, async () => {
    logger.info('scheduler', 'Building digest...');
    const liveConfig = getEffectiveConfig(db, config);
    const data = await safeCollect('digest-build', () => buildDigest(db, liveConfig));
    if (data) {
      await safeCollect('digest-send', () => sendDigest(data, liveConfig));
      pruneOldData(db);
    }
  }, { timezone: config.timezone }));
  logger.info('scheduler', `Digest scheduled: ${config.digestCron} (${config.timezone})`);

  scheduledTasks.push(cron.schedule(config.updateCheckCron, async () => {
    logger.info('scheduler', 'Checking for image updates...');
    const updates = await safeCollect('updates', () => checkUpdates(docker));
    if (updates && updates.length > 0) {
      safeCollect('ingest-updates', () => ingestUpdates(db, hostId, updates));
    }
  }, { timezone: config.timezone }));
  logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
}

module.exports = { startHubScheduler, startStandaloneScheduler, stopScheduler };
