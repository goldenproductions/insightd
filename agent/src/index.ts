import logger = require('../../shared/utils/logger');
import { getRuntime, DockerRuntime } from './runtime';
import type { ContainerRuntime } from './runtime/types';

const { config, validate } = require('./config') as {
  config: {
    hostId: string;
    runtime: 'auto' | 'docker' | 'containerd' | 'kubernetes';
    nodeName: string;
    nodeIp: string;
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
const { connect, disconnect } = require('./mqtt') as { connect: (config: any, runtime: ContainerRuntime) => Promise<any>; disconnect: () => void };
const { startAgentScheduler } = require('./scheduler') as { startAgentScheduler: (runtime: ContainerRuntime, config: any) => void };

async function main(): Promise<void> {
  logger.info('agent', `Starting insightd agent (host: ${config.hostId})...`);

  // Validate config
  const warnings = validate();
  warnings.forEach((w: string) => logger.warn('config', w));

  // Initialize container runtime
  let runtime: ContainerRuntime;
  try {
    runtime = await getRuntime({
      runtime: config.runtime,
      dockerSocket: config.dockerSocket,
      allowActions: config.allowActions,
      nodeName: config.nodeName,
      nodeIp: config.nodeIp,
    });
  } catch (err) {
    logger.error('runtime', 'Cannot initialize container runtime', err);
    process.exit(1);
  }

  // Connect to MQTT
  try {
    await connect(config, runtime);
  } catch (err) {
    logger.error('mqtt', 'Cannot connect to MQTT broker', err);
    process.exit(1);
  }

  // Clean up old containers from previous updates (Docker-only self-update flow)
  if (runtime instanceof DockerRuntime) {
    const { cleanupOldContainers } = require('./updater') as { cleanupOldContainers: (docker: any) => Promise<void> };
    await cleanupOldContainers(runtime.getClient());
  }

  // Start collection scheduler
  startAgentScheduler(runtime, config);

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
