const cron = require('node-cron');
const logger = require('./utils/logger');
const { safeCollect } = require('./utils/errors');
const { pruneOldData } = require('./db/schema');

function startScheduler({ db, docker, config, collectors, digest, alerts }) {
  const { collectContainers, collectResources, collectDisk, checkUpdates } = collectors;
  const { buildDigest, sendDigest } = digest;

  // Run a full collection cycle
  async function runCollection() {
    logger.info('scheduler', 'Starting collection cycle');
    const containers = await safeCollect('containers', () => collectContainers(db, docker));
    if (containers) {
      await safeCollect('resources', () => collectResources(db, docker, containers));
    }
    await safeCollect('disk', () => collectDisk(db, config));
    logger.info('scheduler', 'Collection cycle complete');

    // Evaluate and send alerts after each collection
    if (alerts) {
      await safeCollect('alerts', () => alerts.runAlerts(db, config));
    }
  }

  // Run immediately on startup
  runCollection();

  // Schedule collection every N minutes
  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  cron.schedule(collectCron, runCollection, { timezone: config.timezone });
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

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

  // Schedule daily update checks
  cron.schedule(config.updateCheckCron, async () => {
    logger.info('scheduler', 'Checking for image updates...');
    await safeCollect('updates', () => checkUpdates(db, docker));
  }, { timezone: config.timezone });
  logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
}

module.exports = { startScheduler };
