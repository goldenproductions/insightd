import fs = require('fs');
import cron = require('node-cron');
import logger = require('../../shared/utils/logger');
import type { ContainerRuntime } from './runtime/types';

const { safeCollect } = require('../../shared/utils/errors') as { safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null> };
const { publishCollection, publishUpdates } = require('./mqtt') as { publishCollection: (hostId: string, data: any) => Promise<void>; publishUpdates: (hostId: string, updates: any[]) => Promise<void> };

interface SchedulerConfig {
  hostId: string;
  hostGroup?: string;
  collectIntervalMinutes: number;
  updateCheckCron: string;
  timezone: string;
  hostRoot: string;
  diskWarnPercent?: number;
}

function startAgentScheduler(runtime: ContainerRuntime, config: SchedulerConfig): void {
  const { collectDisk } = require('./collectors/disk') as { collectDisk: (config: any) => any[] };
  const { collectHost } = require('./collectors/host') as { collectHost: (config: any) => any };
  const { collectGpu } = require('./collectors/gpu') as { collectGpu: () => any };
  const { collectTemperature } = require('./collectors/temperature') as { collectTemperature: (config: any) => any };
  const { collectDiskIO } = require('./collectors/disk-io') as { collectDiskIO: (config: any) => any };
  const { collectNetworkIO } = require('./collectors/network-io') as { collectNetworkIO: (config: any) => any };

  async function runCollection(): Promise<void> {
    logger.info('scheduler', 'Starting collection cycle');

    let containers = await safeCollect('containers', () => runtime.listContainers());
    if (containers) {
      containers = await safeCollect('resources', () => runtime.collectResources(containers!));
    }

    const disk = await safeCollect('disk', () => Promise.resolve(collectDisk(config))) || [];
    const host = await safeCollect('host', () => Promise.resolve(collectHost(config)));
    const gpu = await safeCollect('gpu', () => Promise.resolve(collectGpu()));
    const temperature = await safeCollect('temperature', () => Promise.resolve(collectTemperature(config)));
    const diskIO = await safeCollect('disk-io', () => Promise.resolve(collectDiskIO(config)));
    const networkIO = await safeCollect('network-io', () => Promise.resolve(collectNetworkIO(config)));

    logger.info('scheduler', 'Collection cycle complete');

    // Publish to MQTT
    if (containers) {
      await safeCollect('mqtt-publish', () =>
        publishCollection(config.hostId, { containers, disk, host, gpu, temperature, diskIO, networkIO, runtimeName: runtime.name, hostGroup: config.hostGroup })
      );
    }

    // Write health file for Docker HEALTHCHECK
    try { fs.writeFileSync('/tmp/insightd-healthy', ''); } catch { /* ignore */ }
  }

  // Run immediately
  runCollection();

  // Schedule collection
  const collectCron = `*/${config.collectIntervalMinutes} * * * *`;
  cron.schedule(collectCron, runCollection, { timezone: config.timezone });
  logger.info('scheduler', `Collection scheduled: ${collectCron}`);

  // Schedule update checks (only if the runtime supports them)
  if (runtime.supportsUpdateChecks) {
    cron.schedule(config.updateCheckCron, async () => {
      logger.info('scheduler', 'Checking for image updates...');
      const updates = await safeCollect('updates', () => runtime.checkImageUpdates());
      if (updates && updates.length > 0) {
        await safeCollect('mqtt-updates', () =>
          publishUpdates(config.hostId, updates)
        );
      }
    }, { timezone: config.timezone });
    logger.info('scheduler', `Update checks scheduled: ${config.updateCheckCron}`);
  } else {
    logger.info('scheduler', `Update checks disabled for ${runtime.name} runtime`);
  }
}

module.exports = { startAgentScheduler };
