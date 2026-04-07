import type Database from 'better-sqlite3';
const { config, validate } = require('./config');
const { getDb, closeDb } = require('./db/connection');
const { bootstrap } = require('./db/schema');
import logger = require('./utils/logger');

async function main(): Promise<void> {
  logger.info('main', 'Starting insightd...');

  // Validate config
  const warnings: string[] = validate();
  warnings.forEach((w: string) => logger.warn('config', w));

  // Init database
  const db: Database.Database = getDb(config.dbPath);
  bootstrap(db);

  // Init Docker connection
  const Docker = require('dockerode');
  const docker = new Docker({ socketPath: config.dockerSocket });

  // Verify Docker socket access
  try {
    const info = await docker.info();
    logger.info('docker', `Connected \u2014 ${info.Containers} containers, ${info.Images} images`);
  } catch (err) {
    logger.error('docker', 'Cannot connect to Docker socket. Is it mounted?', err);
    process.exit(1);
  }

  // Load collectors
  const { collectContainers } = require('./collectors/containers');
  const { collectResources } = require('./collectors/resources');
  const { collectDisk } = require('./collectors/disk');
  const { checkUpdates } = require('./collectors/updates');

  // Load digest
  const { buildDigest } = require('./digest/builder');
  const { sendDigest } = require('./digest/sender');

  // Load alerts (conditionally)
  let alerts: { runAlerts: (db: Database.Database, config: any) => Promise<void> } | null = null;
  if (config.alerts.enabled) {
    const { runAlerts } = require('./alerts/evaluator');
    alerts = { runAlerts };
    logger.info('main', 'Alerts enabled');
  }

  // Load scheduler
  const { startScheduler } = require('./scheduler');

  startScheduler({
    db,
    docker,
    config,
    collectors: { collectContainers, collectResources, collectDisk, checkUpdates },
    digest: { buildDigest, sendDigest },
    alerts,
  });

  logger.info('main', 'insightd is running');

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('main', 'Shutting down...');
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Don't crash on unhandled errors
  process.on('uncaughtException', (err: Error) => {
    logger.error('main', 'Uncaught exception', err);
  });
  process.on('unhandledRejection', (err: unknown) => {
    logger.error('main', 'Unhandled rejection', err);
  });
}

main().catch((err: Error) => {
  logger.error('main', 'Fatal startup error', err);
  process.exit(1);
});
