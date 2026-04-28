import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { containerInfoToPayload } = require('../../agent/src/mqtt');
const { payloadContainerToSnapshot } = require('../../hub/src/mqtt');

/**
 * Regression test for fields silently dropped between agent publish and
 * hub ingest. Caught last_oom_killed_at being missing on both sides during
 * v40 manual testing — neither side complained, the column just stayed NULL.
 *
 * Every field on ContainerInfo that the schema persists must travel both
 * directions. If you add a column, add it to this fixture too.
 */
describe('MQTT container payload round-trip', () => {
  const sampleAgentInput = {
    name: 'web', id: 'abc123', status: 'running',
    cpuPercent: 12.5, memoryMb: 256.4, restartCount: 7,
    networkRxBytes: 1000, networkTxBytes: 2000,
    blkioReadBytes: 3000, blkioWriteBytes: 4000,
    healthStatus: 'unhealthy',
    healthCheckOutput: 'connection refused',
    labels: { app: 'web' },
    exitCode: 137,
    sizeRootfsBytes: 50_000_000,
    sizeRwBytes: 1_000_000,
    cpuLimitCores: 0.5,
    cpuLimitPercent: 50,
    memoryLimitMb: 512,
    lastOomKilledAt: '2026-04-28T11:38:15.460Z',
  };

  it('agent → snake_case payload includes every camelCase field', () => {
    const payload = containerInfoToPayload(sampleAgentInput);
    // Spot-check the fields whose mapping is most easily broken.
    assert.equal(payload.last_oom_killed_at, '2026-04-28T11:38:15.460Z');
    assert.equal(payload.exit_code, 137);
    assert.equal(payload.memory_limit_mb, 512);
    assert.equal(payload.cpu_limit_cores, 0.5);
    assert.equal(payload.size_rootfs_bytes, 50_000_000);
    assert.equal(payload.health_check_output, 'connection refused');
  });

  it('hub payload → snapshot recovers every camelCase field the agent emitted', () => {
    const payload = containerInfoToPayload(sampleAgentInput);
    const snapshot = payloadContainerToSnapshot(payload);
    // Compare every camelCase field that survives the round-trip. Labels
    // are expected to differ — the agent JSON-stringifies on the way out,
    // the hub passes it through as a string for the DB column.
    const expected: Record<string, any> = { ...sampleAgentInput };
    delete expected.labels;  // checked separately
    for (const [k, v] of Object.entries(expected)) {
      assert.deepEqual(snapshot[k], v, `field ${k} should round-trip unchanged`);
    }
  });

  it('round-trips a null lastOomKilledAt as null (default for non-OOM containers)', () => {
    const input = { ...sampleAgentInput, lastOomKilledAt: null };
    const snap = payloadContainerToSnapshot(containerInfoToPayload(input));
    assert.equal(snap.lastOomKilledAt, null);
  });

  it('round-trips an undefined lastOomKilledAt as null', () => {
    const { lastOomKilledAt: _, ...input } = sampleAgentInput;
    const snap = payloadContainerToSnapshot(containerInfoToPayload(input));
    assert.equal(snap.lastOomKilledAt, null);
  });
});
