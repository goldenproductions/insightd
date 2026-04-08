import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { suppressConsole } = require('../helpers/mocks');
const { DOCKER_CONTAINER_STOPPED, DOCKER_CONTAINER_LIST } = require('../helpers/fixtures');

describe('performContainerAction', () => {
  let performContainerAction: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    // Clear module cache so config is re-read
    delete require.cache[require.resolve('../../agent/src/container-actions')];
    delete require.cache[require.resolve('../../agent/src/config')];
  });

  afterEach(() => {
    restore();
  });

  function loadWithActions(allowed = true) {
    // Mock config before requiring module
    require.cache[require.resolve('../../agent/src/config')] = {
      id: require.resolve('../../agent/src/config'),
      filename: require.resolve('../../agent/src/config'),
      loaded: true,
      exports: { config: { allowActions: allowed } },
    } as any;
    const mod = require('../../agent/src/container-actions');
    performContainerAction = mod.performContainerAction;
  }

  function createDocker(containers: any[]) {
    return {
      listContainers: async () => containers,
      getContainer: () => ({
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        remove: async () => {},
      }),
    };
  }

  it('removes a stopped container successfully', async () => {
    loadWithActions(true);
    const docker = createDocker(DOCKER_CONTAINER_STOPPED);
    const result = await performContainerAction(docker, 'nginx', 'remove');
    assert.equal(result.status, 'success');
    assert.match(result.message, /removed successfully/);
  });

  it('blocks remove on a running container', async () => {
    loadWithActions(true);
    const docker = createDocker(DOCKER_CONTAINER_LIST);
    await assert.rejects(
      () => performContainerAction(docker, 'nginx', 'remove'),
      { message: /running.*Stop it before removing/ }
    );
  });

  it('blocks remove on internal containers', async () => {
    loadWithActions(true);
    const containers = [
      { Names: ['/insightd-hub'], Id: 'hub123', State: 'exited', Image: 'insightd-hub:latest', Labels: { 'insightd.internal': 'true' } },
    ];
    const docker = createDocker(containers);
    await assert.rejects(
      () => performContainerAction(docker, 'insightd-hub', 'remove'),
      { message: /Cannot remove internal/ }
    );
  });

  it('blocks remove when actions are disabled', async () => {
    loadWithActions(false);
    const docker = createDocker(DOCKER_CONTAINER_STOPPED);
    await assert.rejects(
      () => performContainerAction(docker, 'nginx', 'remove'),
      { message: /actions are disabled/ }
    );
  });

  it('throws when container not found', async () => {
    loadWithActions(true);
    const docker = createDocker([]);
    await assert.rejects(
      () => performContainerAction(docker, 'nonexistent', 'remove'),
      { message: /not found/ }
    );
  });

  it('starts a stopped container', async () => {
    loadWithActions(true);
    const docker = createDocker(DOCKER_CONTAINER_STOPPED);
    const result = await performContainerAction(docker, 'nginx', 'start');
    assert.equal(result.status, 'success');
    assert.match(result.message, /started successfully/);
  });

  it('stops a running container', async () => {
    loadWithActions(true);
    const docker = createDocker(DOCKER_CONTAINER_LIST);
    const result = await performContainerAction(docker, 'nginx', 'stop');
    assert.equal(result.status, 'success');
    assert.match(result.message, /stopped successfully/);
  });

  it('rejects invalid actions', async () => {
    loadWithActions(true);
    const docker = createDocker(DOCKER_CONTAINER_LIST);
    await assert.rejects(
      () => performContainerAction(docker, 'nginx', 'destroy'),
      { message: /Invalid action/ }
    );
  });
});
