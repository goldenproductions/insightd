import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const child_process = require('child_process');

function loadRuntime(stub: (file: string, args: string[]) => string | Error): typeof import('../../agent/src/runtime/proxmox') {
  mock.method(child_process, 'execFile', (
    file: string, args: string[], _options: any,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    try {
      const out = stub(file, args);
      if (out instanceof Error) cb(out, '', '');
      else cb(null, out, '');
    } catch (err) {
      cb(err as Error, '', '');
    }
  });
  delete require.cache[require.resolve('../../agent/src/runtime/proxmox')];
  return require('../../agent/src/runtime/proxmox');
}

const CLUSTER_STATUS = JSON.stringify([
  { type: 'cluster', name: 'home', quorate: 1 },
  { type: 'node', name: 'pve-01', local: 1, online: 1 },
]);

const SAMPLE_JOURNAL = [
  '2026-05-05T17:42:13+0000 web systemd[1]: Started nginx.service.',
  '2026-05-05T17:42:14+0000 web nginx[123]: server started on :80',
  'a malformed line without a leading timestamp',
].join('\n');

describe('ProxmoxRuntime.fetchLogs (PR4)', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('parses journalctl --machine output for an LXC guest', async () => {
    const calls: string[] = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      if (file === '/usr/bin/pvesh') return CLUSTER_STATUS;
      calls.push(file);
      if (file === 'journalctl') return SAMPLE_JOURNAL;
      throw new Error(`unexpected exec: ${file}`);
    });
    const r = new ProxmoxRuntime();
    await r.init();
    const logs = await r.fetchLogs('lxc/200', { lines: 50 });
    assert.equal(calls[0], 'journalctl', 'journalctl --machine should be tried first');
    assert.equal(logs.length, 3);
    assert.equal(logs[0].timestamp, '2026-05-05T17:42:13+0000');
    assert.match(logs[0].message, /Started nginx/);
    // Malformed line falls through with timestamp=null.
    assert.equal(logs[2].timestamp, null);
  });

  it('falls back to `pct exec journalctl` when --machine fails', async () => {
    const calls: string[] = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      if (file === '/usr/bin/pvesh') return CLUSTER_STATUS;
      calls.push(file);
      if (file === 'journalctl') return new Error("Failed to get D-Bus connection");
      if (file === 'pct') return SAMPLE_JOURNAL;
      throw new Error(`unexpected exec: ${file}`);
    });
    const r = new ProxmoxRuntime();
    await r.init();
    const logs = await r.fetchLogs('lxc/200', { lines: 50 });
    assert.deepEqual(calls, ['journalctl', 'pct']);
    assert.equal(logs.length, 3);
  });

  it('returns [] (not throw) when both LXC log paths fail', async () => {
    const { ProxmoxRuntime } = loadRuntime((file) => {
      if (file === '/usr/bin/pvesh') return CLUSTER_STATUS;
      return new Error('whatever');
    });
    const r = new ProxmoxRuntime();
    await r.init();
    const logs = await r.fetchLogs('lxc/200', { lines: 50 });
    assert.deepEqual(logs, []);
  });

  it('throws a clear error for QEMU (UI uses this to render an empty-state)', async () => {
    const { ProxmoxRuntime } = loadRuntime(() => CLUSTER_STATUS);
    const r = new ProxmoxRuntime();
    await r.init();
    await assert.rejects(
      () => r.fetchLogs('qemu/103', { lines: 50 }),
      /not available for QEMU/i,
    );
  });

  it('rejects unparseable container ids', async () => {
    const { ProxmoxRuntime } = loadRuntime(() => CLUSTER_STATUS);
    const r = new ProxmoxRuntime();
    await r.init();
    await assert.rejects(
      () => r.fetchLogs('garbage', { lines: 50 }),
      /Unrecognised PVE guest id/,
    );
  });

  it('clamps lines to a sane upper bound', async () => {
    let argsSeen: string[] = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      if (file === '/usr/bin/pvesh') return CLUSTER_STATUS;
      argsSeen = args;
      return SAMPLE_JOURNAL;
    });
    const r = new ProxmoxRuntime();
    await r.init();
    await r.fetchLogs('lxc/200', { lines: 999_999 });
    // -n value should be the clamped 10000, not 999999.
    const nIdx = argsSeen.indexOf('-n');
    assert.equal(argsSeen[nIdx + 1], '10000');
  });
});
