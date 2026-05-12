// tests/unit/agent-process-poller.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { runPollCycle, newState, makeKey } =
  require('../../agent/src/collectors/processes/poller');

function proc(p: Partial<any>): any {
  return {
    pid: 0, ppid: 1, argvHash: 'h', argvFull: ['/bin/x'], comm: 'x', argv: '/bin/x',
    startedAt: '2026-05-12T00:00:00Z', source: 'host', ...p,
  };
}

describe('poller cycle', () => {
  it('emits spawns for new keys, exits for vanished keys', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');

    const cycle1 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100 }), proc({ pid: 101, startedAt: 's1' })],
      now: () => now,
    });
    assert.equal(cycle1.spawns.length, 2);
    assert.equal(cycle1.exits.length, 0);

    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100 }), proc({ pid: 102 })],
      now: () => now,
    });
    assert.equal(cycle2.spawns.length, 1, 'only 102 is new');
    assert.equal(cycle2.spawns[0].pid, 102);
    assert.equal(cycle2.exits.length, 1, '101 vanished');
    assert.equal(cycle2.exits[0].pid, 101);
    assert.equal(cycle2.exits[0].lifetime_ms, 5000);
  });

  it('container source wins; host /proc gap-fills only unclaimed PIDs', async () => {
    const state = newState();
    let claimedSeen: Set<number> | null = null;
    const result = await runPollCycle(state, {
      collectDocker: async () => new Map([[100, proc({ pid: 100, source: 'docker', containerId: 'C' })]]),
      collectK8s:    async () => new Map(),
      collectHost:   (claimed: Set<number>) => {
        claimedSeen = claimed;
        return [proc({ pid: 200 })];
      },
      now: () => new Date('2026-05-12T00:00:00Z'),
    });
    assert.deepEqual([...claimedSeen!].sort(), [100]);
    assert.equal(result.spawns.length, 2);
    const docker = result.spawns.find((s: any) => s.pid === 100)!;
    assert.equal(docker.source, 'docker');
    assert.equal(docker.container_id, 'C');
    const host = result.spawns.find((s: any) => s.pid === 200)!;
    assert.equal(host.source, 'host');
    assert.equal(host.container_id, undefined);
  });

  it('argv_defs include each hash only the first time it ships', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');
    const cycle1 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [
        proc({ pid: 100, argvHash: 'A' }),
        proc({ pid: 101, argvHash: 'A' }),
        proc({ pid: 102, argvHash: 'B' }),
      ],
      now: () => now,
    });
    assert.equal(cycle1.argv_defs.length, 2,
      'A and B each once');

    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [
        proc({ pid: 100, argvHash: 'A' }),
        proc({ pid: 103, argvHash: 'C' }),
      ],
      now: () => now,
    });
    assert.deepEqual(cycle2.argv_defs.map((d: any) => d.argv_hash).sort(), ['C']);
  });

  it('PID reuse with new startedAt is treated as new spawn', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');
    await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100, startedAt: 's1' })],
      now: () => now,
    });
    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100, startedAt: 's2' })],
      now: () => now,
    });
    assert.equal(cycle2.spawns.length, 1);
    assert.equal(cycle2.exits.length, 1);
    assert.equal(cycle2.exits[0].started_at, 's1');
  });
});
