const cron = require('node-cron');
const logger = require('../../shared/utils/logger');
const { safeCollect } = require('../../shared/utils/errors');
const { pruneOldData } = require('./db/schema');

/**
 * Hub scheduler — runs digest and alert jobs.
 * In hub mode: only digest + alerts (data comes via MQTT).
 */
function startHubScheduler(db, config) {
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');

  // Schedule digest delivery
  cron.schedule(config.digestCron, async () => {
    logger.info('scheduler', 'Building digest...');
    const data = await safeCollect('digest-build', () => buildDigest(db, config));
    if (data) {
      await safeCollect('digest-send', () => sendDigest(data, config));
      pruneOldData(db);
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Digest scheduled: ${config.digestCron} (${config.timezone})`);

  // Schedule alert evaluation after each MQTT message is processed
  // In hub mode, alerts run on a timer since we don't control collection timing
  if (config.alerts.enabled) {
    const alertCron = `*/${Math.max(1, config.collectIntervalMinutes || 5)} * * * *`;
    cron.schedule(alertCron, async () => {
      const { runAlerts } = require('./alerts/evaluator');
      await safeCollect('alerts', () => runAlerts(db, config));
    }, { timezone: config.timezone });
    logger.info('scheduler', `Alert evaluation scheduled: ${alertCron}`);
  }
}

/**
 * Standalone scheduler — collection + digest + alerts (no MQTT).
 * This is backwards compatible with the original single-container mode.
 */
function startStandaloneScheduler(db, docker, config) {
  const { collectContainers } = require('../../src/collectors/containers');
  const { collectResources } = require('../../src/collectors/resources');
  const { collectDisk } = require('../../src/collectors/disk');
  const { checkUpdates } = require('../../src/collectors/updates');
  const { ingestContainers, ingestDisk, ingestUpdates, upsertHost } = require('./ingest');
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

    logger.info('scheduler', 'Collection cycle complete');

    if (alerts) {
      await safeCollect('alerts', () => alerts.runAlerts(db, config));
    }
  }

  runCollection();

  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  cron.schedule(collectCron, runCollection, { timezone: config.timezone });
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

  cron.schedule(config.digestCron, async () => {
    logger.info('scheduler', 'Building digest...');
    const data = await safeCollect('digest-build', () => buildDigest(db, config));
    if (data) {
      await safeCollect('digest-send', () => sendDigest(data, config));
      pruneOldData(db);
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Digest scheduled: ${config.digestCron} (${config.timezone})`);

  cron.schedule(config.updateCheckCron, async () => {
    logger.info('scheduler', 'Checking for image updates...');
    const updates = await safeCollect('updates', () => checkUpdates(docker));
    if (updates && updates.length > 0) {
      safeCollect('ingest-updates', () => ingestUpdates(db, hostId, updates));
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
}

module.exports = { startHubScheduler, startStandaloneScheduler };
