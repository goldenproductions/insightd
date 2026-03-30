const { config, validate } = require('./config');
const { getDb, closeDb } = require('./db/connection');
const { bootstrap } = require('./db/schema');
const logger = require('../../shared/utils/logger');

async function main() {
  const mode = config.mqttUrl ? 'hub' : 'standalone';
  logger.info('main', `Starting insightd ${mode} mode...`);

  // Validate config
  const warnings = validate();
  warnings.forEach(w => logger.warn('config', w));

  // Init database
  const db = getDb(config.dbPath);
  bootstrap(db);

  if (mode === 'hub') {
    // Hub mode: receive data via MQTT, run digest + alerts
    const { startSubscriber, disconnect } = require('./mqtt');
    const { startHubScheduler } = require('./scheduler');

    try {
      await startSubscriber(db, config);
    } catch (err) {
      logger.error('mqtt', 'Cannot connect to MQTT broker', err);
      process.exit(1);
    }

    startHubScheduler(db, config);
    logger.info('main', 'insightd hub is running (MQTT mode)');

    const shutdown = () => {
      logger.info('main', 'Shutting down...');
      disconnect();
      closeDb();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    // Standalone mode: collect locally + digest + alerts (backwards compatible)
    const Docker = require('dockerode');
    const docker = new Docker({ socketPath: config.dockerSocket });

    try {
      const info = await docker.info();
      logger.info('docker', `Connected — ${info.Containers} containers, ${info.Images} images`);
    } catch (err) {
      logger.error('docker', 'Cannot connect to Docker socket. Is it mounted?', err);
      process.exit(1);
    }

    const { startStandaloneScheduler } = require('./scheduler');
    startStandaloneScheduler(db, docker, config);

    logger.info('main', 'insightd is running (standalone mode)');

    const shutdown = () => {
      logger.info('main', 'Shutting down...');
      closeDb();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  process.on('uncaughtException', (err) => logger.error('main', 'Uncaught exception', err));
  process.on('unhandledRejection', (err) => logger.error('main', 'Unhandled rejection', err));
}

main().catch(err => {
  logger.error('main', 'Fatal startup error', err);
  process.exit(1);
});
