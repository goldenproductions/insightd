import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseCadvisorMetrics } = require('../../agent/src/runtime/kubernetes') as {
  parseCadvisorMetrics: (raw: string) => Map<string, any>;
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
