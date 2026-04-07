import logger = require('../utils/logger');
import type Dockerode from 'dockerode';

interface ContainerData {
  name: string;
  id: string;
  status: string;
  restartCount: number;
  healthStatus: string | null;
  labels: Record<string, string>;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
  blkioReadBytes?: number | null;
  blkioWriteBytes?: number | null;
}

// In-memory restart tracking state
// Maps container name → { restartCount, lastStartedAt }
const restartState = new Map<string, { restartCount: number; lastStartedAt: string | null }>();

/**
 * Collect container status from Docker.
 * Returns plain data array — no DB writes.
 */
async function collectContainers(docker: Dockerode): Promise<ContainerData[]> {
  const containers = await docker.listContainers({ all: true });

  const parsed: ContainerData[] = containers.map(c => ({
    name: (c.Names[0] || '').replace(/^\//, ''),
    id: c.Id.slice(0, 12),
    status: c.State,
    restartCount: 0,
    healthStatus: null,
    labels: c.Labels || {},
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

function _resetRestartState(): void { restartState.clear(); }

module.exports = { collectContainers, _resetRestartState };
