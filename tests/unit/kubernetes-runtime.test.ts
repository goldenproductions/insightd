import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseCadvisorMetrics, parseQuantity, KubernetesRuntime } = require('../../agent/src/runtime/kubernetes') as {
  parseCadvisorMetrics: (raw: string) => Map<string, any>;
  parseQuantity: (q: string | undefined | null) => number | null;
  KubernetesRuntime: any;
};

describe('parseCadvisorMetrics', () => {
  it('parses container CPU and memory', () => {
    const raw = [
      '# HELP container_cpu_usage_seconds_total Cumulative cpu time consumed',
      '# TYPE container_cpu_usage_seconds_total counter',
      'container_cpu_usage_seconds_total{pod="nginx-abc",namespace="default",container="nginx",pod_uid="uid-1"} 12.5',
      'container_memory_working_set_bytes{pod="nginx-abc",namespace="default",container="nginx",pod_uid="uid-1"} 104857600',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    const m = result.get('uid-1:nginx');
    assert.ok(m, 'should have entry for uid-1:nginx');
    assert.equal(m.cpuUsageSeconds, 12.5);
    assert.equal(m.memoryUsageBytes, 104857600);
  });

  it('handles multiple containers in the same pod', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="multi",namespace="default",container="app",pod_uid="uid-2"} 5.0',
      'container_cpu_usage_seconds_total{pod="multi",namespace="default",container="sidecar",pod_uid="uid-2"} 1.5',
      'container_memory_working_set_bytes{pod="multi",namespace="default",container="app",pod_uid="uid-2"} 50000000',
      'container_memory_working_set_bytes{pod="multi",namespace="default",container="sidecar",pod_uid="uid-2"} 10000000',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.equal(result.get('uid-2:app').cpuUsageSeconds, 5.0);
    assert.equal(result.get('uid-2:sidecar').cpuUsageSeconds, 1.5);
    assert.equal(result.get('uid-2:app').memoryUsageBytes, 50000000);
    assert.equal(result.get('uid-2:sidecar').memoryUsageBytes, 10000000);
  });

  it('distributes pod-level network bytes to every container in the pod', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="web",namespace="default",container="nginx",pod_uid="uid-3"} 1.0',
      'container_cpu_usage_seconds_total{pod="web",namespace="default",container="sidecar",pod_uid="uid-3"} 2.0',
      // Pod-level network metrics — no `container` label
      'container_network_receive_bytes_total{pod="web",namespace="default",pod_uid="uid-3"} 4096',
      'container_network_transmit_bytes_total{pod="web",namespace="default",pod_uid="uid-3"} 8192',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.equal(result.get('uid-3:nginx').networkRxBytes, 4096);
    assert.equal(result.get('uid-3:nginx').networkTxBytes, 8192);
    assert.equal(result.get('uid-3:sidecar').networkRxBytes, 4096);
    assert.equal(result.get('uid-3:sidecar').networkTxBytes, 8192);
    // The internal __pod__ marker should not leak out
    assert.equal(result.get('uid-3:__pod__'), undefined);
  });

  it('parses fs read/write byte counters', () => {
    const raw = [
      'container_fs_reads_bytes_total{pod="db",namespace="default",container="postgres",pod_uid="uid-4"} 1000',
      'container_fs_writes_bytes_total{pod="db",namespace="default",container="postgres",pod_uid="uid-4"} 2000',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    const m = result.get('uid-4:postgres');
    assert.equal(m.fsReadBytes, 1000);
    assert.equal(m.fsWriteBytes, 2000);
  });

  it('skips entries with empty container or container="POD"', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="x",namespace="default",container="",pod_uid="uid-5"} 99',
      'container_cpu_usage_seconds_total{pod="x",namespace="default",container="POD",pod_uid="uid-5"} 99',
      'container_cpu_usage_seconds_total{pod="x",namespace="default",container="real",pod_uid="uid-5"} 1.0',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.equal(result.get('uid-5:real').cpuUsageSeconds, 1.0);
    assert.equal(result.get('uid-5:'), undefined);
    assert.equal(result.get('uid-5:POD'), undefined);
  });

  it('ignores comment lines and blank lines', () => {
    const raw = [
      '',
      '# HELP container_cpu_usage_seconds_total ...',
      '# TYPE container_cpu_usage_seconds_total counter',
      '',
      'container_cpu_usage_seconds_total{pod="p",namespace="default",container="c",pod_uid="uid-6"} 1.0',
      '',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.equal(result.get('uid-6:c').cpuUsageSeconds, 1.0);
  });

  it('ignores malformed lines without {labels}', () => {
    const raw = [
      'malformed line without curly braces 5',
      'container_cpu_usage_seconds_total{pod="p",namespace="default",container="c",pod_uid="uid-7"} 1.0',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.equal(result.size, 1);
    assert.ok(result.get('uid-7:c'));
  });

  it('extracts pod_uid from cgroup id label as fallback', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="x",namespace="default",container="c",id="/kubepods/burstable/pod0badf00d-1234-5678-9abc-def012345678/abc"} 1.0',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.ok(result.get('0badf00d-1234-5678-9abc-def012345678:c'));
  });

  it('falls back to pod name when no UID is available', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="my-pod",namespace="default",container="c"} 1.0',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    assert.ok(result.get('my-pod:c'));
  });

  it('drops non-finite values', () => {
    const raw = [
      'container_cpu_usage_seconds_total{pod="p",namespace="default",container="c",pod_uid="uid-8"} NaN',
      'container_cpu_usage_seconds_total{pod="p",namespace="default",container="c",pod_uid="uid-8"} 5.0',
    ].join('\n');

    const result = parseCadvisorMetrics(raw);
    // The first line is skipped, the second adds 5
    assert.equal(result.get('uid-8:c').cpuUsageSeconds, 5);
  });
});

describe('parseQuantity', () => {
  it('parses bytes with no suffix', () => {
    assert.equal(parseQuantity('1234567'), 1234567);
  });

  it('parses decimal SI suffixes', () => {
    assert.equal(parseQuantity('1k'), 1000);
    assert.equal(parseQuantity('1M'), 1_000_000);
    assert.equal(parseQuantity('1G'), 1_000_000_000);
    assert.equal(parseQuantity('1T'), 1e12);
  });

  it('parses binary IEC suffixes', () => {
    assert.equal(parseQuantity('1Ki'), 1024);
    assert.equal(parseQuantity('1Mi'), 1024 ** 2);
    assert.equal(parseQuantity('1Gi'), 1024 ** 3);
    assert.equal(parseQuantity('16Gi'), 16 * 1024 ** 3);
    assert.equal(parseQuantity('16384Mi'), 16384 * 1024 ** 2);
  });

  it('parses decimal-valued quantities', () => {
    assert.equal(parseQuantity('1.5Gi'), 1.5 * 1024 ** 3);
  });

  it('returns null for null/undefined/empty', () => {
    assert.equal(parseQuantity(null), null);
    assert.equal(parseQuantity(undefined), null);
    assert.equal(parseQuantity(''), null);
  });

  it('returns null for unrecognized suffix', () => {
    assert.equal(parseQuantity('100zi'), null);
  });

  it('returns null for non-numeric input', () => {
    assert.equal(parseQuantity('abc'), null);
    assert.equal(parseQuantity('NaN'), null);
  });
});

describe('KubernetesRuntime.getHostMetrics', () => {
  // We can't run init() without a real cluster, so we instantiate the runtime
  // and inject minimal stubs for the private fields the method touches.
  function makeRuntime(stubs: { kubeletStats: any; node: any | null }): any {
    const runtime = new KubernetesRuntime({ nodeName: 'k3d-test', nodeIp: '127.0.0.1' });
    runtime.coreApi = {
      readNode: async (_name: string) => {
        if (stubs.node === null) throw new Error('node not found');
        return stubs.node;
      },
    };
    runtime.fetchKubeletStats = async () => stubs.kubeletStats;
    return runtime;
  }

  it('combines kubelet stats and Node API capacity into a metrics override', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const runtime = makeRuntime({
      kubeletStats: {
        node: {
          // 0.5 cores out of 4 → 12.5%
          cpu: { usageNanoCores: 500_000_000 },
          // 2 GiB used, 2 GiB free
          memory: { workingSetBytes: 2 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 },
        },
      },
      node: {
        metadata: { creationTimestamp: oneHourAgo },
        status: {
          capacity: { cpu: '4', memory: '4Gi' },
          allocatable: { cpu: '4', memory: '4Gi' },
        },
      },
    });

    const m = await runtime.getHostMetrics();
    assert.ok(m);
    assert.equal(m.cpuPercent, 12.5);
    assert.equal(m.memoryUsedMb, 2048);
    assert.equal(m.memoryAvailableMb, 2048);
    assert.equal(m.memoryTotalMb, 4096);
    // Uptime comes from Node.metadata.creationTimestamp (~3600s)
    assert.ok(m.uptimeSeconds! >= 3590 && m.uptimeSeconds! <= 3610, `~3600s, got ${m.uptimeSeconds}`);
    // Load and (implicitly) temperature are explicitly null in k8s
    assert.equal(m.load1, null);
    assert.equal(m.load5, null);
    assert.equal(m.load15, null);
  });

  it('ignores kubelet startTime even when present (it returns the host kernel boot time inside k3d)', async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const longAgo = '2025-01-01T00:00:00Z'; // would be many days; must be ignored
    const runtime = makeRuntime({
      kubeletStats: { node: { startTime: longAgo, cpu: {}, memory: {} } },
      node: {
        metadata: { creationTimestamp: oneDayAgo },
        status: { capacity: { cpu: '2', memory: '2Gi' }, allocatable: { cpu: '2', memory: '2Gi' } },
      },
    });
    const m = await runtime.getHostMetrics();
    assert.ok(m);
    // Should be ~24h (from creationTimestamp), NOT ~100+ days (from kubelet startTime)
    assert.ok(m.uptimeSeconds! >= 86_390 && m.uptimeSeconds! <= 86_410, `expected ~86400s, got ${m.uptimeSeconds}`);
  });

  it('returns null fields when kubelet provides no usage data', async () => {
    const runtime = makeRuntime({
      kubeletStats: { node: { cpu: {}, memory: {} } },
      node: {
        metadata: { creationTimestamp: new Date().toISOString() },
        status: { capacity: { cpu: '2', memory: '2Gi' }, allocatable: { cpu: '2', memory: '2Gi' } },
      },
    });
    const m = await runtime.getHostMetrics();
    assert.ok(m);
    assert.equal(m.cpuPercent, undefined);
    assert.equal(m.memoryUsedMb, undefined);
    assert.equal(m.memoryAvailableMb, undefined);
    // memoryTotalMb still comes from Node capacity
    assert.equal(m.memoryTotalMb, 2048);
  });

  it('returns null when both kubelet and Node API fail', async () => {
    const runtime = new KubernetesRuntime({ nodeName: 'k3d-test', nodeIp: '127.0.0.1' });
    runtime.coreApi = {
      readNode: async () => { throw new Error('api down'); },
    };
    runtime.fetchKubeletStats = async () => { throw new Error('kubelet down'); };
    const m = await runtime.getHostMetrics();
    assert.equal(m, null);
  });

  it('prefers allocatable over capacity for total memory', async () => {
    const runtime = makeRuntime({
      kubeletStats: { node: { cpu: {}, memory: {} } },
      node: {
        metadata: { creationTimestamp: new Date().toISOString() },
        status: {
          capacity:    { cpu: '4', memory: '8Gi' },
          allocatable: { cpu: '4', memory: '7800Mi' },  // ~200 Mi reserved for system
        },
      },
    });
    const m = await runtime.getHostMetrics();
    assert.equal(m!.memoryTotalMb, 7800);
  });
});

describe('KubernetesRuntime constructor: kubeletUrl precedence', () => {
  it('uses explicit kubeletUrl when provided', () => {
    const runtime: any = new KubernetesRuntime({
      nodeName: 'n1',
      nodeIp: '10.0.0.5',
      kubeletUrl: 'https://kubelet.example:4443',
    });
    assert.equal(runtime.kubeletUrl, 'https://kubelet.example:4443');
  });

  it('falls back to https://${nodeIp}:10250 when kubeletUrl is not set', () => {
    const runtime: any = new KubernetesRuntime({ nodeName: 'n1', nodeIp: '10.0.0.5' });
    assert.equal(runtime.kubeletUrl, 'https://10.0.0.5:10250');
  });

  it('falls back to loopback when neither kubeletUrl nor nodeIp is set', () => {
    const runtime: any = new KubernetesRuntime({ nodeName: 'n1' });
    assert.equal(runtime.kubeletUrl, 'https://127.0.0.1:10250');
  });

  it('prefers explicit kubeletUrl over nodeIp-derived URL', () => {
    const runtime: any = new KubernetesRuntime({
      nodeName: 'n1',
      nodeIp: '10.0.0.5',
      kubeletUrl: 'https://override:12345',
    });
    assert.equal(runtime.kubeletUrl, 'https://override:12345');
  });
});

describe('KubernetesRuntime.listContainers: healthCheckOutput extraction', () => {
  // Build a runtime with a stubbed coreApi that returns the given pods.
  function makeRuntime(pods: any[]): any {
    const runtime: any = new KubernetesRuntime({ nodeName: 'k3d-test', nodeIp: '127.0.0.1' });
    runtime.coreApi = {
      listPods: async () => ({ items: pods }),
    };
    runtime.appsApi = runtime.coreApi;
    return runtime;
  }

  function basePod(containerStatus: any): any {
    return {
      metadata: { name: 'crashloop', namespace: 'default', uid: 'uid-1', labels: {} },
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: 'app',
          ready: false,
          restartCount: 3,
          image: 'busybox:latest',
          ...containerStatus,
        }],
      },
    };
  }

  it('extracts reason+message from state.waiting', async () => {
    const runtime = makeRuntime([basePod({
      state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers.length, 1);
    assert.equal(containers[0].healthCheckOutput, 'CrashLoopBackOff: back-off 5m0s restarting failed container');
  });

  it('extracts reason-only from state.waiting when message is missing', async () => {
    const runtime = makeRuntime([basePod({
      state: { waiting: { reason: 'ImagePullBackOff' } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers[0].healthCheckOutput, 'ImagePullBackOff');
  });

  it('extracts from lastState.terminated when state is running', async () => {
    const runtime = makeRuntime([basePod({
      ready: true,
      state: { running: { startedAt: new Date().toISOString() } },
      lastState: { terminated: { reason: 'OOMKilled' } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers[0].healthCheckOutput, 'OOMKilled');
  });

  it('prefers current state.waiting over lastState.terminated', async () => {
    const runtime = makeRuntime([basePod({
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { reason: 'Error', message: 'exit 1' } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers[0].healthCheckOutput, 'CrashLoopBackOff');
  });

  it('returns null when neither waiting nor terminated has a reason', async () => {
    const runtime = makeRuntime([basePod({
      ready: true,
      state: { running: { startedAt: new Date().toISOString() } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers[0].healthCheckOutput, null);
  });

  it('truncates long messages to 500 chars for column parity with Docker', async () => {
    const longMessage = 'x'.repeat(1000);
    const runtime = makeRuntime([basePod({
      state: { waiting: { reason: 'Error', message: longMessage } },
    })]);
    const containers = await runtime.listContainers();
    assert.equal(containers[0].healthCheckOutput!.length, 500);
    assert.ok(containers[0].healthCheckOutput!.startsWith('Error: xxxx'));
  });
});
