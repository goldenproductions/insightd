import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { suppressConsole } = require('../helpers/mocks');
const { DOCKER_CONTAINER_STOPPED, DOCKER_CONTAINER_LIST } = require('../helpers/fixtures');

describe('DockerRuntime.performAction', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
  });

  afterEach(() => {
    restore();
  });

  function createRuntime(containers: any[], allowActions = true): any {
    // Import the class and stub the Docker client
    delete require.cache[require.resolve('../../agent/src/runtime/docker')];
    const { DockerRuntime } = require('../../agent/src/runtime/docker');
    const runtime = new DockerRuntime({ socketPath: '/tmp/fake.sock', allowActions });
    // Stub getClient() with a fake dockerode-like object
    const fakeDocker = {
      listContainers: async () => containers,
      getContainer: () => ({
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        remove: async () => {},
      }),
    };
    runtime.getClient = () => fakeDocker;
    return runtime;
  }

  it('removes a stopped container successfully', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_STOPPED, true);
    const result = await runtime.performAction('nginx', 'remove');
    assert.equal(result.status, 'success');
    assert.match(result.message, /removed successfully/);
  });

  it('blocks remove on a running container', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_LIST, true);
    await assert.rejects(
      () => runtime.performAction('nginx', 'remove'),
      { message: /running.*Stop it before removing/ }
    );
  });

  it('blocks remove on internal containers', async () => {
    const containers = [
      { Names: ['/insightd-hub'], Id: 'hub123', State: 'exited', Image: 'insightd-hub:latest', Labels: { 'insightd.internal': 'true' } },
    ];
    const runtime = createRuntime(containers, true);
    await assert.rejects(
      () => runtime.performAction('insightd-hub', 'remove'),
      { message: /Cannot remove internal/ }
    );
  });

  it('blocks remove when actions are disabled', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_STOPPED, false);
    await assert.rejects(
      () => runtime.performAction('nginx', 'remove'),
      { message: /actions are disabled/ }
    );
  });

  it('throws when container not found', async () => {
    const runtime = createRuntime([], true);
    await assert.rejects(
      () => runtime.performAction('nonexistent', 'remove'),
      { message: /not found/ }
    );
  });

  it('starts a stopped container', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_STOPPED, true);
    const result = await runtime.performAction('nginx', 'start');
    assert.equal(result.status, 'success');
    assert.match(result.message, /started successfully/);
  });

  it('stops a running container', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_LIST, true);
    const result = await runtime.performAction('nginx', 'stop');
    assert.equal(result.status, 'success');
    assert.match(result.message, /stopped successfully/);
  });

  it('rejects invalid actions', async () => {
    const runtime = createRuntime(DOCKER_CONTAINER_LIST, true);
    await assert.rejects(
      () => runtime.performAction('nginx', 'destroy'),
      { message: /Invalid action/ }
    );
  });
});
