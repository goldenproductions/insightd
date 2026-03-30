const logger = require('../../../shared/utils/logger');
const { safeCollect } = require('../../../shared/utils/errors');

// In-memory store for previous CPU stats (needed for delta calculation)
const prevStats = new Map();

/**
 * Collect CPU and memory stats for running containers.
 * Returns the containers array with cpuPercent and memoryMb merged in.
 * Does not write to DB.
 */
async function collectResources(docker, containers) {
  for (const c of containers) {
    if (c.status !== 'running') continue;

    await safeCollect(`resources:${c.name}`, async () => {
      const container = docker.getContainer(c.id);

      // Get stats with a timeout
      const stats = await Promise.race([
        container.stats({ stream: false }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stats timeout')), 10000)
        ),
      ]);

      // Calculate CPU %
      let cpuPercent = null;
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
      let networkRxBytes = null;
      let networkTxBytes = null;
      if (stats.networks) {
        networkRxBytes = 0;
        networkTxBytes = 0;
        for (const iface of Object.values(stats.networks)) {
          networkRxBytes += iface.rx_bytes || 0;
          networkTxBytes += iface.tx_bytes || 0;
        }
      }

      // Block I/O
      let blkioReadBytes = null;
      let blkioWriteBytes = null;
      const ioEntries = stats.blkio_stats?.io_service_bytes_recursive;
      if (Array.isArray(ioEntries) && ioEntries.length > 0) {
        blkioReadBytes = 0;
        blkioWriteBytes = 0;
        for (const entry of ioEntries) {
          const op = (entry.op || '').toLowerCase();
          if (op === 'read') blkioReadBytes += entry.value || 0;
          if (op === 'write') blkioWriteBytes += entry.value || 0;
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

function _resetPrevStats() { prevStats.clear(); }

module.exports = { collectResources, _resetPrevStats };
