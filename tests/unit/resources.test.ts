import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { DOCKER_STATS, DOCKER_STATS_SECOND } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

describe('collectResources', () => {
  let collectResources: Function;
  let _resetPrevStats: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    delete require.cache[require.resolve('../../src/collectors/resources')];
    const mod = require('../../src/collectors/resources');
    collectResources = mod.collectResources;
    _resetPrevStats = mod._resetPrevStats;
    _resetPrevStats();
  });

  afterEach(() => {
    restore();
  });

  function createMockDockerWithStats(statsResult: any) {
    return {
      getContainer: () => ({
        stats: async () => statsResult,
      }),
    };
  }

  it('first call produces null CPU (no previous stats)', async () => {
    const docker = createMockDockerWithStats(DOCKER_STATS);
    const containers = [{ name: 'nginx', id: 'abc123', status: 'running' }];
    const result = await collectResources(docker, containers);
    assert.equal(result[0].cpuPercent, null);
  });

  it('second call produces valid CPU percentage', async () => {
    const docker1 = createMockDockerWithStats(DOCKER_STATS);
    const containers = [{ name: 'nginx', id: 'abc123', status: 'running' }];
    await collectResources(docker1, containers);

    const docker2 = createMockDockerWithStats(DOCKER_STATS_SECOND);
    const result = await collectResources(docker2, [{ name: 'nginx', id: 'abc123', status: 'running' }]);
    assert.ok(result[0].cpuPercent !== null);
    assert.ok(result[0].cpuPercent >= 0);
  });

  it('calculates memory in MB correctly', async () => {
    const docker = createMockDockerWithStats(DOCKER_STATS);
    const containers = [{ name: 'nginx', id: 'abc123', status: 'running' }];
    const result = await collectResources(docker, containers);
    assert.equal(result[0].memoryMb, 100); // 104857600 / 1024 / 1024
  });

  it('skips non-running containers', async () => {
    const docker = createMockDockerWithStats(DOCKER_STATS);
    const containers = [{ name: 'nginx', id: 'abc123', status: 'exited' }];
    const result = await collectResources(docker, containers);
    assert.equal(result[0].cpuPercent, undefined);
    assert.equal(result[0].memoryMb, undefined);
  });

  it('returns null CPU when counters reset (container restart)', async () => {
    const docker1 = createMockDockerWithStats(DOCKER_STATS_SECOND);
    await collectResources(docker1, [{ name: 'nginx', id: 'abc123', status: 'running' }]);

    const resetStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 100000 },
        system_cpu_usage: 12000000000,
        online_cpus: 2,
      },
      memory_stats: { usage: 52428800 },
    };
    const docker2 = createMockDockerWithStats(resetStats);
    const result = await collectResources(docker2, [{ name: 'nginx', id: 'abc123', status: 'running' }]);
    assert.equal(result[0].cpuPercent, null);
  });

  it('handles stats timeout gracefully', async () => {
    const docker = {
      getContainer: () => ({
        stats: () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
      }),
    };
    const containers = [{ name: 'nginx', id: 'abc123', status: 'running' }];
    const result = await collectResources(docker, containers);
    assert.equal(result[0].cpuPercent, undefined); // safeCollect caught the error
  });
});
