import logger = require('../../../shared/utils/logger');
import type Dockerode from 'dockerode';

const { safeCollect } = require('../../../shared/utils/errors') as { safeCollect: <T>(label: string, fn: () => Promise<T>) => Promise<T | null> };

interface ContainerWithResources {
  name: string;
  id: string;
  status: string;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
  blkioReadBytes?: number | null;
  blkioWriteBytes?: number | null;
  [key: string]: unknown;
}

// In-memory store for previous CPU stats (needed for delta calculation)
const prevStats = new Map<string, Record<string, any>>();

/**
 * Collect CPU and memory stats for running containers.
 * Returns the containers array with cpuPercent and memoryMb merged in.
 * Does not write to DB.
 */
async function collectResources(docker: Dockerode, containers: ContainerWithResources[]): Promise<ContainerWithResources[]> {
  for (const c of containers) {
    if (c.status !== 'running') continue;

    await safeCollect(`resources:${c.name}`, async () => {
      const container = docker.getContainer(c.id);

      // Get stats with a timeout
      const stats = await Promise.race([
        container.stats({ stream: false }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Stats timeout')), 10000)
        ),
      ]) as Record<string, any>;

      // Calculate CPU %
      let cpuPercent: number | null = null;
      const prev = prevStats.get(c.id);
      if (prev) {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - prev.cpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - prev.cpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || 1;
        if (systemDelta > 0 && cpuDelta >= 0) {
          cpuPercent = Math.round((cpuDelta / systemDelta) * cpuCount * 100 * 100) / 100;
        } else if (cpuDelta < 0) {
          // Container restarted — counters reset. Discard this reading.
          cpuPercent = null;
        }
      }
      prevStats.set(c.id, stats);

      // Calculate memory MB
      const memoryMb = Math.round((stats.memory_stats.usage || 0) / 1024 / 1024 * 100) / 100;

      // Network I/O — sum across all interfaces
      let networkRxBytes: number | null = null;
      let networkTxBytes: number | null = null;
      if (stats.networks) {
        networkRxBytes = 0;
        networkTxBytes = 0;
        for (const iface of Object.values(stats.networks) as Array<{ rx_bytes?: number; tx_bytes?: number }>) {
          networkRxBytes! += iface.rx_bytes || 0;
          networkTxBytes! += iface.tx_bytes || 0;
        }
      }

      // Block I/O
      let blkioReadBytes: number | null = null;
      let blkioWriteBytes: number | null = null;
      const ioEntries = stats.blkio_stats?.io_service_bytes_recursive;
      if (Array.isArray(ioEntries) && ioEntries.length > 0) {
        blkioReadBytes = 0;
        blkioWriteBytes = 0;
        for (const entry of ioEntries as Array<{ op?: string; value?: number }>) {
          const op = (entry.op || '').toLowerCase();
          if (op === 'read') blkioReadBytes! += entry.value || 0;
          if (op === 'write') blkioWriteBytes! += entry.value || 0;
        }
      }

      // Merge into the container object
      c.cpuPercent = cpuPercent;
      c.memoryMb = memoryMb;
      c.networkRxBytes = networkRxBytes;
      c.networkTxBytes = networkTxBytes;
      c.blkioReadBytes = blkioReadBytes;
      c.blkioWriteBytes = blkioWriteBytes;

      logger.info('resources', `${c.name}: CPU=${cpuPercent ?? 'pending'}%, RAM=${memoryMb}MB`);
    });
  }

  // Clean up stale entries for removed containers
  const currentIds = new Set(containers.map(c => c.id));
  for (const id of prevStats.keys()) {
    if (!currentIds.has(id)) prevStats.delete(id);
  }

  return containers;
}

function _resetPrevStats(): void { prevStats.clear(); }

module.exports = { collectResources, _resetPrevStats };
