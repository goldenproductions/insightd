const cron = require('node-cron');
const logger = require('./utils/logger');
const { safeCollect } = require('./utils/errors');
const { pruneOldData } = require('./db/schema');
const { ingestContainers, ingestDisk, ingestUpdates, upsertHost } = require('./ingest');

function startScheduler({ db, docker, config, collectors, digest, alerts }) {
  const { collectContainers, collectResources, collectDisk, checkUpdates } = collectors;
  const { buildDigest, sendDigest } = digest;
  const hostId = config.hostId || 'local';

  // Run a full collection cycle
  async function runCollection() {
    logger.info('scheduler', 'Starting collection cycle');

    // Collect data (pure functions, no DB writes)
    let containers = await safeCollect('containers', () => collectContainers(docker));
    if (containers) {
      containers = await safeCollect('resources', () => collectResources(docker, containers));
      // Ingest into database
      safeCollect('ingest-containers', () => {
        ingestContainers(db, hostId, containers);
        upsertHost(db, hostId);
      });
    }

    const diskResults = await safeCollect('disk', () => collectDisk(config));
    if (diskResults && diskResults.length > 0) {
      safeCollect('ingest-disk', () => ingestDisk(db, hostId, diskResults));
    }

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
    const updates = await safeCollect('updates', () => checkUpdates(docker));
    if (updates && updates.length > 0) {
      safeCollect('ingest-updates', () => ingestUpdates(db, hostId, updates));
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
}

module.exports = { startScheduler };
