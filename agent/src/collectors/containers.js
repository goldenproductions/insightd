const logger = require('../../../shared/utils/logger');

// In-memory restart tracking state
// Maps container name → { restartCount, lastStartedAt }
const restartState = new Map();

/**
 * Collect container status from Docker.
 * Returns plain data array — no DB writes.
 */
async function collectContainers(docker) {
  const containers = await docker.listContainers({ all: true });

  const parsed = containers.map(c => ({
    name: (c.Names[0] || '').replace(/^\//, ''),
    id: c.Id.slice(0, 12),
    status: c.State,
    restartCount: 0,
    healthStatus: null,
  }));

  // Enrich with restart counts via inspect
  for (const p of parsed) {
    try {
      const info = await docker.getContainer(p.id).inspect();
      const dockerRestarts = info.RestartCount || 0;
      const startedAt = info.State?.StartedAt;

      const prev = restartState.get(p.name);
      if (!prev) {
        // First time seeing this container
        p.restartCount = dockerRestarts;
      } else if (dockerRestarts > prev.restartCount) {
        // Docker-tracked restarts increased
        p.restartCount = dockerRestarts;
      } else if (startedAt && info.State?.Running && prev.lastStartedAt) {
        // Check if container restarted manually (StartedAt changed)
        if (startedAt !== prev.lastStartedAt) {
          p.restartCount = prev.restartCount + 1;
        } else {
          p.restartCount = prev.restartCount;
        }
      } else {
        p.restartCount = prev.restartCount;
      }

      // Health status
      p.healthStatus = info.State?.Health?.Status || null;

      // Update state
      restartState.set(p.name, {
        restartCount: p.restartCount,
        lastStartedAt: startedAt || null,
      });
    } catch {
      // container may have been removed between list and inspect
      const prev = restartState.get(p.name);
      if (prev) p.restartCount = prev.restartCount;
    }
  }

  // Clean up stale entries for removed containers
  const currentNames = new Set(parsed.map(p => p.name));
  for (const name of restartState.keys()) {
    if (!currentNames.has(name)) restartState.delete(name);
  }

  logger.info('containers', `Collected ${parsed.length} containers`);
  return parsed;
}

function _resetRestartState() { restartState.clear(); }

module.exports = { collectContainers, _resetRestartState };
