// tests/unit/agent-docker-top.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { parseDockerTop, viaDockerTop } =
  require('../../agent/src/collectors/processes/dockerTop');

describe('parseDockerTop', () => {
  it('parses dockerode Top() output', () => {
    const dockerodeOut = {
      Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
      Processes: [
        ['100', '1', 'nginx', 'nginx: master process /usr/sbin/nginx'],
        ['101', '100', 'nginx', 'nginx: worker process'],
      ],
    };
    const procs = parseDockerTop(dockerodeOut);
    assert.equal(procs.length, 2);
    assert.equal(procs[0].pid, 100);
    assert.equal(procs[0].ppid, 1);
    assert.deepEqual(procs[0].argvFull,
      ['nginx:', 'master', 'process', '/usr/sbin/nginx']);
  });

  it('returns [] when Processes is missing or empty', () => {
    assert.deepEqual(parseDockerTop({ Titles: [], Processes: null }), []);
    assert.deepEqual(parseDockerTop({ Titles: [], Processes: [] }), []);
  });

  it('skips rows shorter than the column index requires', () => {
    const out = parseDockerTop({
      Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
      Processes: [
        ['100', '1', 'nginx'],  // missing ARGS column
        ['101', '1', 'nginx', '/usr/sbin/nginx'],
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].pid, 101);
  });

  it('skips rows whose pid or ppid is non-numeric', () => {
    const out = parseDockerTop({
      Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
      Processes: [
        ['xyz', '1', 'a', '/x'],
        ['1', 'xyz', 'a', '/x'],
        ['1', '0', 'a', '/x'],
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].pid, 1);
  });
});

describe('viaDockerTop', () => {
  it('aggregates per-container with timeout, container source wins', async () => {
    const stub = {
      getContainer(id: string) {
        return {
          top: async () => ({
            Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
            Processes: [[String(parseInt(id) + 100), '1', 'x', '/bin/x']],
          }),
        };
      },
    };
    const map = await viaDockerTop(stub, [
      { Id: '1', Names: ['/a'] },
      { Id: '2', Names: ['/b'] },
    ], { timeoutMs: 1000, bootTimeMs: 0, argvMaxBytes: 4096 });
    assert.equal(map.size, 2);
    const pid101 = map.get(101)!;
    assert.equal(pid101.source, 'docker');
    assert.equal(pid101.containerId, '1');
  });

  it('skips containers whose top() exceeds timeout', async () => {
    const stub = {
      getContainer(id: string) {
        return {
          top: () => new Promise(resolve =>
            setTimeout(() => resolve({ Titles: [], Processes: [] }), id === '1' ? 50 : 10000)
          ),
        };
      },
    };
    const map = await viaDockerTop(stub, [
      { Id: '1', Names: ['/fast'] },
      { Id: '2', Names: ['/slow'] },
    ], { timeoutMs: 200, bootTimeMs: 0, argvMaxBytes: 4096 });
    const sources = Array.from(map.values()).map((p: any) => p.containerId);
    assert.ok(!sources.includes('2'));
  });
});
