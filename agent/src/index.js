const { config, validate } = require('./config');
const logger = require('../../shared/utils/logger');
const { connect, disconnect } = require('./mqtt');
const { startAgentScheduler } = require('./scheduler');

async function main() {
  logger.info('agent', `Starting insightd agent (host: ${config.hostId})...`);

  // Validate config
  const warnings = validate();
  warnings.forEach(w => logger.warn('config', w));

  // Connect to Docker
  const Docker = require('dockerode');
  const docker = new Docker({ socketPath: config.dockerSocket });

  try {
    const info = await docker.info();
    logger.info('docker', `Connected — ${info.Containers} containers, ${info.Images} images`);
  } catch (err) {
    logger.error('docker', 'Cannot connect to Docker socket. Is it mounted?', err);
    process.exit(1);
  }

  // Connect to MQTT
  try {
    await connect(config);
  } catch (err) {
    logger.error('mqtt', 'Cannot connect to MQTT broker', err);
    process.exit(1);
  }

  // Start collection scheduler
  startAgentScheduler(docker, config);

  logger.info('agent', 'insightd agent is running');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('agent', 'Shutting down...');
    disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => logger.error('agent', 'Uncaught exception', err));
  process.on('unhandledRejection', (err) => logger.error('agent', 'Unhandled rejection', err));
}

main().catch(err => {
  logger.error('agent', 'Fatal startup error', err);
  process.exit(1);
});
