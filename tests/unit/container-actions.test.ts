import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { suppressConsole } = require('../helpers/mocks');
const { DOCKER_CONTAINER_STOPPED, DOCKER_CONTAINER_LIST, DOCKER_STATS, DOCKER_STATS_SECOND } = require('../helpers/fixtures');

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

describe('DockerRuntime.collectResources', () => {
  let restore: () => void;

  beforeEach(() => { restore = suppressConsole(); });
  afterEach(() => { restore(); });

  function createRuntimeWithStats(statsSequence: any[]): any {
    delete require.cache[require.resolve('../../agent/src/runtime/docker')];
    const { DockerRuntime } = require('../../agent/src/runtime/docker');
    const runtime = new DockerRuntime({ socketPath: '/tmp/fake.sock', allowActions: false });
    let callIdx = 0;
    const fakeDocker = {
      getContainer: (_id: string) => ({
        stats: async () => statsSequence[Math.min(callIdx++, statsSequence.length - 1)],
      }),
    };
    runtime.getClient = () => fakeDocker;
    return runtime;
  }

  it('skips containers that are not running', async () => {
    const runtime = createRuntimeWithStats([DOCKER_STATS]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'exited', restartCount: 0, healthStatus: null, labels: {} }];
    const result = await runtime.collectResources(containers);
    assert.equal(result[0].cpuPercent, undefined, 'no resources collected for stopped container');
  });

  it('first call returns null cpuPercent (no prevStats yet)', async () => {
    const runtime = createRuntimeWithStats([DOCKER_STATS]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'running', restartCount: 0, healthStatus: null, labels: {} }];
    const result = await runtime.collectResources(containers);
    assert.equal(result[0].cpuPercent, null);
    assert.equal(result[0].memoryMb, 100); // 104857600 bytes
  });

  it('second call computes CPU% from delta', async () => {
    const runtime = createRuntimeWithStats([DOCKER_STATS, DOCKER_STATS_SECOND]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'running', restartCount: 0, healthStatus: null, labels: {} }];
    await runtime.collectResources(containers);
    const second = await runtime.collectResources(containers);
    // cpu_delta = 600M - 500M = 100M
    // system_delta = 11B - 10B = 1B
    // cpu_count = 2
    // cpuPercent = (100M / 1B) * 2 * 100 = 20%
    assert.equal(second[0].cpuPercent, 20);
    assert.equal(second[0].memoryMb, 110); // 115343360 bytes ≈ 110 MB
  });

  it('aggregates network bytes from multiple interfaces', async () => {
    const stats = {
      ...DOCKER_STATS,
      networks: {
        eth0: { rx_bytes: 1000, tx_bytes: 2000 },
        eth1: { rx_bytes: 500, tx_bytes: 750 },
      },
    };
    const runtime = createRuntimeWithStats([stats]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'running', restartCount: 0, healthStatus: null, labels: {} }];
    const result = await runtime.collectResources(containers);
    assert.equal(result[0].networkRxBytes, 1500);
    assert.equal(result[0].networkTxBytes, 2750);
  });

  it('aggregates blkio bytes from io_service_bytes_recursive', async () => {
    const stats = {
      ...DOCKER_STATS,
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 4096 },
          { op: 'Write', value: 8192 },
          { op: 'Read', value: 2048 },
          { op: 'Sync', value: 999 },
        ],
      },
    };
    const runtime = createRuntimeWithStats([stats]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'running', restartCount: 0, healthStatus: null, labels: {} }];
    const result = await runtime.collectResources(containers);
    assert.equal(result[0].blkioReadBytes, 6144);
    assert.equal(result[0].blkioWriteBytes, 8192);
  });

  it('handles missing networks/blkio gracefully', async () => {
    const runtime = createRuntimeWithStats([DOCKER_STATS]);
    const containers = [{ name: 'nginx', id: 'abc', status: 'running', restartCount: 0, healthStatus: null, labels: {} }];
    const result = await runtime.collectResources(containers);
    assert.equal(result[0].networkRxBytes, null);
    assert.equal(result[0].blkioReadBytes, null);
  });
});

describe('parseImage', () => {
  let parseImage: (image: string) => { repo: string; tag: string } | null;

  beforeEach(() => {
    delete require.cache[require.resolve('../../agent/src/runtime/docker')];
    parseImage = require('../../agent/src/runtime/docker').parseImage;
  });

  it('parses official Docker Hub image (no namespace)', () => {
    assert.deepEqual(parseImage('nginx'), { repo: 'library/nginx', tag: 'latest' });
    assert.deepEqual(parseImage('nginx:1.25'), { repo: 'library/nginx', tag: '1.25' });
  });

  it('parses user/repo Docker Hub image', () => {
    assert.deepEqual(parseImage('andreas404/insightd-hub'), { repo: 'andreas404/insightd-hub', tag: 'latest' });
    assert.deepEqual(parseImage('andreas404/insightd-hub:0.7.0'), { repo: 'andreas404/insightd-hub', tag: '0.7.0' });
  });

  it('strips digest suffix', () => {
    assert.deepEqual(
      parseImage('nginx:1.25@sha256:abcdef'),
      { repo: 'library/nginx', tag: '1.25' }
    );
  });

  it('returns null for non-Docker-Hub registries (contains a dot in first segment)', () => {
    assert.equal(parseImage('ghcr.io/owner/repo'), null);
    assert.equal(parseImage('quay.io/calico/node'), null);
    assert.deepEqual(parseImage('rancher/k3s:v1.31.5-k3s1'), { repo: 'rancher/k3s', tag: 'v1.31.5-k3s1' }, 'rancher is on Docker Hub, not a registry domain');
  });
});
