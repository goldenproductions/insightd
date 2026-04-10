import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
const cron = require('node-cron');
import logger = require('./utils/logger');
const { safeCollect } = require('./utils/errors');
const { pruneOldData } = require('./db/schema') as { pruneOldData: (db: Database.Database, rawDays?: number, rollupDays?: number) => void };
const { ingestContainers, ingestDisk, ingestUpdates, upsertHost } = require('./ingest');

interface ContainerData {
  name: string;
  id: string;
  status: string;
  restartCount: number;
  labels?: Record<string, string>;
  [key: string]: any;
}

interface DiskResult {
  mountPoint: string;
  totalGb: number;
  usedGb: number;
  usedPercent: number;
}

interface UpdateResult {
  containerName: string;
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  hasUpdate: boolean;
}

interface Collectors {
  collectContainers: (docker: Dockerode) => Promise<ContainerData[]>;
  collectResources: (docker: Dockerode, containers: ContainerData[]) => Promise<ContainerData[]>;
  collectDisk: (config: SchedulerConfig) => Promise<DiskResult[]>;
  checkUpdates: (docker: Dockerode) => Promise<UpdateResult[]>;
}

interface DigestModule {
  buildDigest: (db: Database.Database, config: SchedulerConfig) => any;
  sendDigest: (data: any, config: SchedulerConfig, db: Database.Database) => Promise<void>;
}

interface AlertsModule {
  runAlerts: (db: Database.Database, config: SchedulerConfig) => Promise<void>;
}

interface SchedulerConfig {
  hostId?: string;
  collectIntervalMinutes: number;
  timezone: string;
  digestCron: string;
  updateCheckCron: string;
  [key: string]: any;
}

interface SchedulerParams {
  db: Database.Database;
  docker: Dockerode;
  config: SchedulerConfig;
  collectors: Collectors;
  digest: DigestModule;
  alerts: AlertsModule | null;
}

function startScheduler({ db, docker, config, collectors, digest, alerts }: SchedulerParams): void {
  const { collectContainers, collectResources, collectDisk, checkUpdates } = collectors;
  const { buildDigest, sendDigest } = digest;
  const hostId = config.hostId || 'local';

  // Run a full collection cycle
  async function runCollection(): Promise<void> {
    logger.info('scheduler', 'Starting collection cycle');

    // Collect data (pure functions, no DB writes)
    let containers = await safeCollect('containers', () => collectContainers(docker));
    if (containers) {
      containers = await safeCollect('resources', () => collectResources(docker, containers));
      // Ingest into database
      safeCollect('ingest-containers', () => {
        ingestContainers(db, hostId, containers);
        upsertHost(db, hostId);
        try {
          const { autoAssignGroups } = require('../hub/src/web/group-queries');
          autoAssignGroups(db, hostId, containers);
        } catch { /* group-queries not available */ }
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
      await safeCollect('digest-send', () => sendDigest(data, config, db));
    }
  }, { timezone: config.timezone });
  logger.info('scheduler', `Digest scheduled: ${config.digestCron} (${config.timezone})`);

  // Schedule daily data prune + rollup (03:30) — independent of digest
  pruneOldData(db); // run once on startup
  cron.schedule('30 3 * * *', () => pruneOldData(db), { timezone: config.timezone });
  logger.info('scheduler', 'Data prune scheduled: daily at 03:30');

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
