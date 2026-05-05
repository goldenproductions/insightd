import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const child_process = require('child_process');

/**
 * ProxmoxRuntime.performAction tests — mocks both pvesh (for the lookup
 * to find the guest type) and pct/qm (for the actual action). Same lazy-
 * require pattern as the PR1 tests.
 */
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
  { type: 'node', name: 'pve-02', local: 0, online: 1 },
]);

const CLUSTER_RESOURCES = JSON.stringify([
  { type: 'lxc', id: 'lxc/200', node: 'pve-01', vmid: 200, name: 'web', status: 'running' },
  { type: 'qemu', id: 'qemu/103', node: 'pve-01', vmid: 103, name: 'db', status: 'running' },
  { type: 'qemu', id: 'qemu/999', node: 'pve-02', vmid: 999, name: 'other-node', status: 'running' },
]);

function defaultStub(file: string, args: string[]): string {
  if (file === '/usr/bin/pvesh') {
    if (args[1] === '/cluster/status') return CLUSTER_STATUS;
    if (args[1] === '/cluster/resources') return CLUSTER_RESOURCES;
    throw new Error(`unexpected pvesh path: ${args[1]}`);
  }
  // pct / qm: success returns no output (PVE typically just exits 0).
  if (file === 'pct' || file === 'qm') return '';
  throw new Error(`unexpected exec: ${file}`);
}

describe('ProxmoxRuntime.performAction (PR4)', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('refuses when allowActions=false (env-var gate)', async () => {
    const { ProxmoxRuntime } = loadRuntime(defaultStub);
    const r = new ProxmoxRuntime({ allowActions: false });
    await r.init();
    await assert.rejects(
      () => r.performAction('pve-01/200', 'start'),
      /actions are disabled/i,
    );
  });

  it('shells `pct start <vmid>` for an LXC start action', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      calls.push({ file, args });
      return defaultStub(file, args);
    });
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    const result = await r.performAction('pve-01/200', 'start');
    assert.equal(result.status, 'success');
    const pctCall = calls.find(c => c.file === 'pct');
    assert.ok(pctCall);
    assert.deepEqual(pctCall!.args, ['start', '200']);
  });

  it('shells `qm shutdown <vmid>` for a QEMU stop action (graceful, not hard kill)', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      calls.push({ file, args });
      return defaultStub(file, args);
    });
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    await r.performAction('pve-01/103', 'stop');
    const qmCall = calls.find(c => c.file === 'qm');
    assert.ok(qmCall);
    // 'shutdown' = graceful ACPI, not 'stop' (which would be a hard kill).
    assert.deepEqual(qmCall!.args, ['shutdown', '103']);
  });

  it('uses `qm reboot` for restart and `qm destroy` for remove', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      calls.push({ file, args });
      return defaultStub(file, args);
    });
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    await r.performAction('pve-01/103', 'restart');
    await r.performAction('pve-01/103', 'remove');
    const qmCalls = calls.filter(c => c.file === 'qm');
    assert.deepEqual(qmCalls.map(c => c.args[0]), ['reboot', 'destroy']);
  });

  it('rejects actions targeting a guest on a different node', async () => {
    const { ProxmoxRuntime } = loadRuntime(defaultStub);
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    // 999 lives on pve-02 (per the fixture); this agent is pve-01.
    await assert.rejects(
      () => r.performAction('pve-02/999', 'start'),
      /not this agent's node/i,
    );
  });

  it('rejects actions on a guest that no longer exists', async () => {
    const { ProxmoxRuntime } = loadRuntime(defaultStub);
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    await assert.rejects(
      () => r.performAction('pve-01/404', 'start'),
      /not found/i,
    );
  });

  it('rejects malformed container names with an actionable error', async () => {
    const { ProxmoxRuntime } = loadRuntime(defaultStub);
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    await assert.rejects(
      () => r.performAction('not-a-vmid', 'start'),
      /expected "<node>\/<vmid>"/,
    );
    await assert.rejects(
      () => r.performAction('pve-01/notnumeric', 'start'),
      /non-numeric vmid/,
    );
  });

  it('surfaces pct/qm errors from the underlying tool unchanged', async () => {
    const { ProxmoxRuntime } = loadRuntime((file, args) => {
      if (file === 'pct') return new Error('pct: unable to start CT 200, container is locked (snapshot)');
      return defaultStub(file, args);
    });
    const r = new ProxmoxRuntime({ allowActions: true });
    await r.init();
    await assert.rejects(
      () => r.performAction('pve-01/200', 'start'),
      /container is locked/,
    );
  });

  it('still reports supportsActions=true even when allowActions=false (capability vs authorization)', async () => {
    const { ProxmoxRuntime } = loadRuntime(defaultStub);
    const r = new ProxmoxRuntime({ allowActions: false });
    // The UI uses supportsActions to decide whether to show the buttons at
    // all; the agent uses allowActions to decide whether to actually run them.
    // Distinguishing the two means a UI showing greyed-out buttons can give a
    // helpful "set INSIGHTD_ALLOW_ACTIONS=true" hint.
    assert.equal(r.supportsActions, true);
  });
});
