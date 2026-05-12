import logger = require('../../shared/utils/logger');
import { getRuntime, DockerRuntime } from './runtime';
import type { ContainerRuntime } from './runtime/types';
import { startProcessCollector } from './collectors/processes/processes';

const { config, validate } = require('./config') as {
  config: {
    hostId: string;
    runtime: 'auto' | 'docker' | 'containerd' | 'kubernetes' | 'proxmox';
    nodeName: string;
    nodeIp: string;
    kubeletUrl: string;
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
    // Proxmox VE — REST API transport (set on the agent talking to PVE) +
    // node identity. See agent/src/config.ts for the env-var origins.
    pveApiUrl: string;
    pveTokenId: string;
    pveTokenSecret: string;
    pveVerifyTls: boolean;
    pveCaBundle: string;
    pveNode: string;
    /** PR4 — in-guest identity bridge (set on the guest VM agent). */
    proxmoxNode: string;
    proxmoxVmid: string;
    processCollection: {
      enabled: boolean;
      pollIntervalMs: number;
      argvMaxBytes: number;
      dockerTopTimeoutMs: number;
    };
  };
  validate: () => string[];
};
const { connect, disconnect, publishIdentityHint } = require('./mqtt') as { connect: (config: any, runtime: ContainerRuntime) => Promise<any>; disconnect: () => void; publishIdentityHint: (hostId: string, hint: any) => Promise<void> };
const { collectIdentityHint } = require('./collectors/identity-hint') as { collectIdentityHint: () => any };
const { safeCollect } = require('../../shared/utils/errors') as { safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null> };
const { startAgentScheduler, setLastIdentityHint } = require('./scheduler') as { startAgentScheduler: (runtime: ContainerRuntime, config: any) => void; setLastIdentityHint: (h: any) => void };

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
      kubeletUrl: config.kubeletUrl,
      pveApiUrl: config.pveApiUrl,
      pveTokenId: config.pveTokenId,
      pveTokenSecret: config.pveTokenSecret,
      pveVerifyTls: config.pveVerifyTls,
      pveCaBundle: config.pveCaBundle,
      pveNode: config.pveNode,
    });
  } catch (err) {
    logger.error('runtime', 'Cannot initialize container runtime', err);
    process.exit(1);
  }

  // Connect to MQTT
  let mqttClient: any;
  try {
    mqttClient = await connect(config, runtime);
  } catch (err) {
    logger.error('mqtt', 'Cannot connect to MQTT broker', err);
    process.exit(1);
  }

  // Clean up old containers from previous updates (Docker-only self-update flow)
  if (runtime instanceof DockerRuntime) {
    const { cleanupOldContainers } = require('./updater') as { cleanupOldContainers: (docker: any) => Promise<void> };
    await cleanupOldContainers(runtime.getClient());
  }

  // Publish identity hint on startup (skip when manual Proxmox bridge override is set)
  if (!config.proxmoxNode || !config.proxmoxVmid) {
    const hint = collectIdentityHint();
    await safeCollect('identity-hint', () => publishIdentityHint(config.hostId, hint));
    setLastIdentityHint(hint);
  }

  // Start collection scheduler
  startAgentScheduler(runtime, config);

  // Start process collector (enabled by default; disable via INSIGHTD_PROCESS_ENABLED=false)
  if (config.processCollection?.enabled) {
    startProcessCollector({
      mqtt: mqttClient,
      hostId: config.hostId,
      runtime,
      hostRoot: config.hostRoot,
      config: config.processCollection,
    });
  }

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
