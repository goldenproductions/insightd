const logger = require('../utils/logger');
const { safeCollect } = require('../utils/errors');

// In-memory store for previous CPU stats (needed for delta calculation)
const prevStats = new Map();

async function collectResources(db, docker, containers) {
  const update = db.prepare(`
    UPDATE container_snapshots
    SET cpu_percent = ?, memory_mb = ?
    WHERE container_id = ? AND collected_at = (
      SELECT collected_at FROM container_snapshots
      WHERE container_id = ? ORDER BY collected_at DESC LIMIT 1
    )
  `);

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
        if (systemDelta > 0) {
          cpuPercent = Math.round((cpuDelta / systemDelta) * cpuCount * 100 * 100) / 100;
        }
      }
      prevStats.set(c.id, stats);

      // Calculate memory MB
      const memoryMb = Math.round((stats.memory_stats.usage || 0) / 1024 / 1024 * 100) / 100;

      update.run(cpuPercent, memoryMb, c.id, c.id);
      logger.info('resources', `${c.name}: CPU=${cpuPercent ?? 'pending'}%, RAM=${memoryMb}MB`);
    });
  }
}

function _resetPrevStats() { prevStats.clear(); }

module.exports = { collectResources, _resetPrevStats };
