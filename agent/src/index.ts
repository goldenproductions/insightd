import logger = require('../../shared/utils/logger');
import type Dockerode from 'dockerode';

const { config, validate } = require('./config') as {
  config: {
    hostId: string;
    dockerSocket: string;
    mqttUrl: string;
    mqttUser: string;
    mqttPass: string;
    collectIntervalMinutes: number;
    updateCheckCron: string;
    timezone: string;
    hostRoot: string;
    diskWarnPercent: number;
    allowUpdates: boolean;
    allowActions: boolean;
    logLines: number;
    logMaxLines: number;
  };
  validate: () => string[];
};
const { connect, disconnect } = require('./mqtt') as { connect: (config: any, docker: Dockerode) => Promise<any>; disconnect: () => void };
const { startAgentScheduler } = require('./scheduler') as { startAgentScheduler: (docker: Dockerode, config: any) => void };

async function main(): Promise<void> {
  logger.info('agent', `Starting insightd agent (host: ${config.hostId})...`);

  // Validate config
  const warnings = validate();
  warnings.forEach((w: string) => logger.warn('config', w));

  // Connect to Docker
  const Docker = require('dockerode') as new (options: { socketPath: string }) => Dockerode;
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
    await connect(config, docker);
  } catch (err) {
    logger.error('mqtt', 'Cannot connect to MQTT broker', err);
    process.exit(1);
  }

  // Clean up old containers from previous updates
  const { cleanupOldContainers } = require('./updater') as { cleanupOldContainers: (docker: Dockerode) => Promise<void> };
  await cleanupOldContainers(docker);

  // Start collection scheduler
  startAgentScheduler(docker, config);

  logger.info('agent', 'insightd agent is running');

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('agent', 'Shutting down...');
    disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err: Error) => logger.error('agent', 'Uncaught exception', err));
  process.on('unhandledRejection', (err: unknown) => logger.error('agent', 'Unhandled rejection', err as Error));
}

main().catch((err: Error) => {
  logger.error('agent', 'Fatal startup error', err);
  process.exit(1);
});
