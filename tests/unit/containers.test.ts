import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { DOCKER_CONTAINER_LIST } = require('../helpers/fixtures');
const { createMockDocker, suppressConsole } = require('../helpers/mocks');

describe('collectContainers', () => {
  let collectContainers: Function;
  let _resetRestartState: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    delete require.cache[require.resolve('../../src/collectors/containers')];
    const mod = require('../../src/collectors/containers');
    collectContainers = mod.collectContainers;
    _resetRestartState = mod._resetRestartState;
    _resetRestartState();
  });

  afterEach(() => {
    restore();
  });

  it('collects all containers', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(docker);
    assert.equal(result.length, 3);
  });

  it('strips leading slash from container names', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(docker);
    assert.equal(result[0].name, 'nginx');
    assert.ok(!result[0].name.startsWith('/'));
  });

  it('truncates container IDs to 12 chars', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(docker);
    assert.equal(result[0].id.length, 12);
  });

  it('returns data without DB dependency', async () => {
    const docker = createMockDocker();
    const result = await collectContainers(docker);
    assert.ok(Array.isArray(result));
    assert.ok(result[0].name);
    assert.ok(result[0].id);
    assert.ok(result[0].status);
    assert.equal(typeof result[0].restartCount, 'number');
  });

  it('enriches restart count from inspect', async () => {
    const docker = createMockDocker({
      inspect: { RestartCount: 3, State: { Running: true, StartedAt: '2020-01-01T00:00:00Z' } },
    });
    const result = await collectContainers(docker);
    assert.equal(result[0].restartCount, 3);
  });

  it('detects manual restart via StartedAt change', async () => {
    // First collection
    const docker1 = createMockDocker({
      containers: [DOCKER_CONTAINER_LIST[0]],
      inspect: { RestartCount: 0, State: { Running: true, StartedAt: '2026-03-29T00:00:00Z' } },
    });
    await collectContainers(docker1);

    // Second collection — StartedAt changed
    const docker2 = createMockDocker({
      containers: [DOCKER_CONTAINER_LIST[0]],
      inspect: { RestartCount: 0, State: { Running: true, StartedAt: '2026-03-30T12:00:00Z' } },
    });
    const result = await collectContainers(docker2);
    assert.equal(result[0].restartCount, 1);
  });

  it('handles inspect failure gracefully', async () => {
    const docker = createMockDocker();
    docker.getContainer = () => ({
      inspect: async () => { throw new Error('container gone'); },
    });
    const result = await collectContainers(docker);
    assert.equal(result.length, 3);
    assert.equal(result[0].restartCount, 0);
  });

  it('handles empty container list', async () => {
    const docker = createMockDocker({ containers: [] });
    const result = await collectContainers(docker);
    assert.equal(result.length, 0);
  });
});
