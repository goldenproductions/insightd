const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/db');
const { DOCKER_CONTAINER_LIST, DOCKER_INSPECT, DOCKER_INSPECT_NO_RESTARTS } = require('../helpers/fixtures');
const { createMockDocker, suppressConsole } = require('../helpers/mocks');

describe('collectContainers', () => {
  let db;
  let collectContainers;
  let restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
    delete require.cache[require.resolve('../../src/collectors/containers')];
    collectContainers = require('../../src/collectors/containers').collectContainers;
  });

  afterEach(() => {
    db.close();
    restore();
  });

  it('collects all containers', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(db, docker);
    assert.equal(result.length, 3);
  });

  it('strips leading slash from container names', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(db, docker);
    assert.equal(result[0].name, 'nginx');
    assert.ok(!result[0].name.startsWith('/'));
  });

  it('truncates container IDs to 12 chars', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(db, docker);
    assert.equal(result[0].id.length, 12);
  });

  it('stores snapshots in database', async () => {
    const docker = createMockDocker();
    await collectContainers(db, docker);
    const rows = db.prepare('SELECT * FROM container_snapshots').all();
    assert.equal(rows.length, 3);
  });

  it('enriches restart count from inspect', async () => {
    const docker = createMockDocker({
      inspect: { RestartCount: 3, State: { Running: true, StartedAt: '2020-01-01T00:00:00Z' } },
    });
    const result = await collectContainers(db, docker);
    assert.equal(result[0].restartCount, 3);
  });

  it('detects manual restart via StartedAt', async () => {
    // First collection — establish baseline
    const oldStart = '2026-03-29T00:00:00Z';
    const docker1 = createMockDocker({
      containers: [DOCKER_CONTAINER_LIST[0]], // just nginx
      inspect: { RestartCount: 0, State: { Running: true, StartedAt: oldStart } },
    });
    await collectContainers(db, docker1);

    // Second collection — container has a newer StartedAt (manual restart)
    const newStart = new Date(Date.now() + 60000).toISOString(); // future to guarantee it's newer
    const docker2 = createMockDocker({
      containers: [DOCKER_CONTAINER_LIST[0]],
      inspect: { RestartCount: 0, State: { Running: true, StartedAt: newStart } },
    });
    const result = await collectContainers(db, docker2);
    assert.equal(result[0].restartCount, 1); // detected restart
  });

  it('handles inspect failure gracefully', async () => {
    const docker = createMockDocker();
    docker.getContainer = () => ({
      inspect: async () => { throw new Error('container gone'); },
    });
    const result = await collectContainers(db, docker);
    assert.equal(result.length, 3);
    assert.equal(result[0].restartCount, 0); // fallback
  });

  it('handles empty container list', async () => {
    const docker = createMockDocker({ containers: [] });
    const result = await collectContainers(db, docker);
    assert.equal(result.length, 0);
  });
});
