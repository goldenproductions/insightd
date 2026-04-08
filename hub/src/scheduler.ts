const cron = require('node-cron');
import logger = require('../../shared/utils/logger');
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';

const { safeCollect } = require('../../shared/utils/errors') as { safeCollect: (label: string, fn: () => any) => Promise<any> };
const { pruneOldData } = require('./db/schema') as { pruneOldData: (db: Database.Database) => void };
const { getEffectiveConfig } = require('./db/settings') as { getEffectiveConfig: (db: Database.Database, config: any) => any };

interface ScheduledTask {
  stop: () => void;
}

interface HubConfig {
  digestCron: string;
  timezone: string;
  collectIntervalMinutes: number;
  alerts: { enabled: boolean };
  [key: string]: any;
}

interface StandaloneConfig extends HubConfig {
  hostId?: string;
  updateCheckCron: string;
}

const scheduledTasks: ScheduledTask[] = [];

function stopScheduler(): void {
  for (const task of scheduledTasks) task.stop();
  scheduledTasks.length = 0;
  logger.info('scheduler', 'All scheduled tasks stopped');
}

/**
 * Hub scheduler — runs digest and alert jobs.
 * In hub mode: only digest + alerts (data comes via MQTT).
 */
function startHubScheduler(db: Database.Database, config: HubConfig): void {
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');

  // Schedule digest delivery
  scheduledTasks.push(cron.schedule(config.digestCron, async () => {
    logger.info('scheduler', 'Building digest...');
    const liveConfig = getEffectiveConfig(db, config);
    const data = await safeCollect('digest-build', () => buildDigest(db, liveConfig));
    if (data) {
      await safeCollect('digest-send', () => sendDigest(data, liveConfig, db));
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

  // Schedule HTTP endpoint checks — every minute, checker decides per-endpoint if due
  scheduledTasks.push(cron.schedule('* * * * *', async () => {
    const { runChecks } = require('./http-monitor/checker');
    await safeCollect('http-checks', () => runChecks(db));
  }, { timezone: config.timezone }));
  logger.info('scheduler', 'HTTP endpoint checks scheduled: every minute');

  // Schedule insights engine — hourly baseline computation + health scores
  scheduledTasks.push(cron.schedule('0 * * * *', async () => {
    logger.info('scheduler', 'Computing insights...');
    const { computeBaselines } = require('./insights/baselines');
    const { computeHealthScores } = require('./insights/health');
    const { generateInsights } = require('./insights/detector');
    // Compute baselines once and pass the cache to downstream functions
    const baselineCache = await safeCollect('baselines', () => computeBaselines(db));
    await safeCollect('health-scores', () => computeHealthScores(db, baselineCache));
    await safeCollect('insights', () => generateInsights(db, baselineCache));
  }, { timezone: config.timezone }));
  logger.info('scheduler', 'Insights engine scheduled: hourly');

  // Schedule version check — daily + run once on startup
  const { checkForUpdates } = require('./version-check');
  checkForUpdates();
  scheduledTasks.push(cron.schedule('0 6 * * *', () => {
    safeCollect('version-check', () => checkForUpdates());
  }, { timezone: config.timezone }));
  logger.info('scheduler', 'Version check scheduled: daily at 06:00');
}

/**
 * Standalone scheduler — collection + digest + alerts (no MQTT).
 * This is backwards compatible with the original single-container mode.
 */
function startStandaloneScheduler(db: Database.Database, docker: Dockerode, config: StandaloneConfig): void {
  const { collectContainers } = require('../../src/collectors/containers');
  const { collectResources } = require('../../src/collectors/resources');
  const { collectDisk } = require('../../src/collectors/disk');
  const { collectHost } = require('../../src/collectors/host');
  const { checkUpdates } = require('../../src/collectors/updates');
  const { ingestContainers, ingestDisk, ingestUpdates, upsertHost, ingestHost } = require('./ingest');
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');
  const hostId = config.hostId || 'local';

  let alerts: { runAlerts: (db: Database.Database, config: any) => Promise<void> } | null = null;
  if (config.alerts.enabled) {
    const { runAlerts } = require('./alerts/evaluator');
    alerts = { runAlerts };
  }

  async function runCollection(): Promise<void> {
    logger.info('scheduler', 'Starting collection cycle');

    let containers = await safeCollect('containers', () => collectContainers(docker));
    if (containers) {
      containers = await safeCollect('resources', () => collectResources(docker, containers));
      safeCollect('ingest-containers', () => {
        ingestContainers(db, hostId, containers);
        upsertHost(db, hostId);
        const { autoAssignGroups } = require('./web/group-queries');
        autoAssignGroups(db, hostId, containers);
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
      await safeCollect('digest-send', () => sendDigest(data, liveConfig, db));
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

  // Schedule HTTP endpoint checks — every minute, checker decides per-endpoint if due
  scheduledTasks.push(cron.schedule('* * * * *', async () => {
    const { runChecks } = require('./http-monitor/checker');
    await safeCollect('http-checks', () => runChecks(db));
  }, { timezone: config.timezone }));
  logger.info('scheduler', 'HTTP endpoint checks scheduled: every minute');
}

module.exports = { startHubScheduler, startStandaloneScheduler, stopScheduler };
