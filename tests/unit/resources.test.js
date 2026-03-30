const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedContainerSnapshots } = require('../helpers/db');
const { DOCKER_STATS, DOCKER_STATS_SECOND, ts, NOW } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

describe('collectResources', () => {
  let db;
  let collectResources;
  let _resetPrevStats;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    delete require.cache[require.resolve('../../src/collectors/resources')];
    const mod = require('../../src/collectors/resources');
    collectResources = mod.collectResources;
    _resetPrevStats = mod._resetPrevStats;
    _resetPrevStats();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  function createMockDockerWithStats(statsResult) {
    return {
      getContainer: (id) => ({
        stats: async () => statsResult,
      }),
    };
  }

  it('first call produces null CPU (no previous stats)', async () => {
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'running', at: ts(NOW) }]);
    const docker = createMockDockerWithStats(DOCKER_STATS);
    const containers = [{ name: 'nginx', id: 'abc123', status: 'running' }];

    await collectResources(db, docker, containers);

    const row = db.prepare('SELECT cpu_percent FROM container_snapshots WHERE container_name = ?').get('nginx');
    assert.equal(row.cpu_percent, null);
  });

  it('second call produces valid CPU percentage', async () => {
    // First call
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'running', at: ts(NOW) }]);
    const docker1 = createMockDockerWithStats(DOCKER_STATS);
    await collectResources(db, docker1, [{ name: 'nginx', id: 'abc123', status: 'running' }]);

    // Second call with new stats
    const now2 = ts(new Date(NOW.getTime() + 300000));
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'running', at: now2 }]);
    const docker2 = createMockDockerWithStats(DOCKER_STATS_SECOND);
    await collectResources(db, docker2, [{ name: 'nginx', id: 'abc123', status: 'running' }]);

    const rows = db.prepare('SELECT cpu_percent FROM container_snapshots WHERE container_name = ? ORDER BY collected_at DESC').all('nginx');
    // The second row should have a non-null CPU
    assert.ok(rows[0].cpu_percent !== null);
    assert.ok(rows[0].cpu_percent >= 0);
  });

  it('calculates memory in MB correctly', async () => {
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'running', at: ts(NOW) }]);
    const docker = createMockDockerWithStats(DOCKER_STATS);
    await collectResources(db, docker, [{ name: 'nginx', id: 'abc123', status: 'running' }]);

    const row = db.prepare('SELECT memory_mb FROM container_snapshots WHERE container_name = ?').get('nginx');
    assert.equal(row.memory_mb, 100); // 104857600 / 1024 / 1024 = 100
  });

  it('skips non-running containers', async () => {
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'exited', at: ts(NOW) }]);
    const docker = createMockDockerWithStats(DOCKER_STATS);
    await collectResources(db, docker, [{ name: 'nginx', id: 'abc123', status: 'exited' }]);

    const row = db.prepare('SELECT cpu_percent, memory_mb FROM container_snapshots WHERE container_name = ?').get('nginx');
    assert.equal(row.cpu_percent, null);
    assert.equal(row.memory_mb, null);
  });

  it('handles stats timeout gracefully', async () => {
    seedContainerSnapshots(db, [{ name: 'nginx', id: 'abc123', status: 'running', at: ts(NOW) }]);
    const docker = {
      getContainer: () => ({
        stats: () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
      }),
    };

    // Should not throw
    await collectResources(db, docker, [{ name: 'nginx', id: 'abc123', status: 'running' }]);
    const row = db.prepare('SELECT cpu_percent FROM container_snapshots WHERE container_name = ?').get('nginx');
    assert.equal(row.cpu_percent, null); // no update on failure
  });
});
