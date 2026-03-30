const { config, validate } = require('./config');
const { getDb, closeDb } = require('./db/connection');
const { bootstrap } = require('./db/schema');
const logger = require('./utils/logger');

async function main() {
  logger.info('main', 'Starting insightd...');

  // Validate config
  const warnings = validate();
  warnings.forEach(w => logger.warn('config', w));

  // Init database
  const db = getDb(config.dbPath);
  bootstrap(db);

  // Init Docker connection
  const Docker = require('dockerode');
  const docker = new Docker({ socketPath: config.dockerSocket });

  // Verify Docker socket access
  try {
    const info = await docker.info();
    logger.info('docker', `Connected — ${info.Containers} containers, ${info.Images} images`);
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

  // Load scheduler
  const { startScheduler } = require('./scheduler');

  startScheduler({
    db,
    docker,
    config,
    collectors: { collectContainers, collectResources, collectDisk, checkUpdates },
    digest: { buildDigest, sendDigest },
  });

  logger.info('main', 'insightd is running');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('main', 'Shutting down...');
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Don't crash on unhandled errors
  process.on('uncaughtException', (err) => {
    logger.error('main', 'Uncaught exception', err);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('main', 'Unhandled rejection', err);
  });
}

main().catch(err => {
  logger.error('main', 'Fatal startup error', err);
  process.exit(1);
});
