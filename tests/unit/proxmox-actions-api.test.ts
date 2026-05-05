import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { ProxmoxRuntime } = require('../../agent/src/runtime/proxmox');
const { __setTestTransport } = require('../../agent/src/runtime/pveApi');

interface RecordedCall {
  kind: 'get' | 'action';
  method?: string;
  path: string;
  body?: Record<string, string>;
}

function fakeRestTransport(stub: (call: RecordedCall) => unknown): { transport: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    transport: {
      mode: 'rest-api',
      async get(path: string) {
        const c: RecordedCall = { kind: 'get', path };
        calls.push(c);
        return stub(c);
      },
      async action(method: string, path: string, body?: Record<string, string>) {
        const c: RecordedCall = { kind: 'action', method, path, body };
        calls.push(c);
        return stub(c);
      },
    },
  };
}

const CLUSTER_STATUS_REMOTE = [
  { type: 'cluster', name: 'home', quorate: 1 },
  { type: 'node', name: 'pve-01', online: 1 },
];

const CLUSTER_RESOURCES = [
  { type: 'lxc', id: 'lxc/200', node: 'pve-01', vmid: 200, name: 'web', status: 'running' },
  { type: 'qemu', id: 'qemu/103', node: 'pve-01', vmid: 103, name: 'db', status: 'running' },
];

function defaultStub(call: RecordedCall): unknown {
  if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
  if (call.path === '/cluster/resources') return CLUSTER_RESOURCES;
  // Action calls return the UPID string PVE would normally hand back.
  if (call.kind === 'action') return 'UPID:pve-01:0001234A:00000000:00000000:vzdump';
  throw new Error(`unexpected call: ${JSON.stringify(call)}`);
}

describe('ProxmoxRuntime.performAction — REST API mode', () => {
  beforeEach(() => __setTestTransport(null));
  afterEach(() => __setTestTransport(null));

  it('refuses when allowActions=false (env-var gate fires before any HTTP)', async () => {
    const { transport, calls } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: false, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const beforeCalls = calls.length;
    await assert.rejects(
      () => r.performAction('pve-01/200', 'start'),
      /actions are disabled/i,
    );
    // No HTTP calls beyond the init's /cluster/status.
    assert.equal(calls.length, beforeCalls, 'gate must fire before the resource lookup HTTP call');
  });

  it('start → POST /nodes/{node}/lxc/{vmid}/status/start, with UPID in success message', async () => {
    const { transport, calls } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const result = await r.performAction('pve-01/200', 'start');
    const action = calls.find(c => c.kind === 'action');
    assert.ok(action);
    assert.equal(action!.method, 'POST');
    assert.equal(action!.path, '/nodes/pve-01/lxc/200/status/start');
    assert.equal(result.status, 'success');
    assert.match(result.message, /UPID:pve-01:0001234A/);
  });

  it('stop → POST /…/status/shutdown (graceful, NOT /stop)', async () => {
    const { transport, calls } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    await r.performAction('pve-01/103', 'stop');
    const action = calls.find(c => c.kind === 'action');
    // Graceful shutdown is the right semantic — `/stop` is a hard kill we
    // deliberately don't expose.
    assert.equal(action!.path, '/nodes/pve-01/qemu/103/status/shutdown');
  });

  it('restart → POST /…/status/reboot', async () => {
    const { transport, calls } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    await r.performAction('pve-01/103', 'restart');
    const action = calls.find(c => c.kind === 'action');
    assert.equal(action!.path, '/nodes/pve-01/qemu/103/status/reboot');
  });

  it('remove → DELETE /nodes/{node}/{type}/{vmid} (no /status/destroy)', async () => {
    const { transport, calls } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    await r.performAction('pve-01/103', 'remove');
    const action = calls.find(c => c.kind === 'action');
    assert.equal(action!.method, 'DELETE');
    // No `/status/...` suffix — destroy is a top-level DELETE on the guest.
    assert.equal(action!.path, '/nodes/pve-01/qemu/103');
  });

  it('rejects actions targeting a guest on a different node', async () => {
    const { transport } = fakeRestTransport(defaultStub);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    await assert.rejects(
      () => r.performAction('pve-02/999', 'start'),
      /not this agent's node/i,
    );
  });

  it('surfaces PVE API errors verbatim (e.g. 403 on missing VM.PowerMgmt)', async () => {
    const { transport } = fakeRestTransport(call => {
      if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
      if (call.path === '/cluster/resources') return CLUSTER_RESOURCES;
      if (call.kind === 'action') {
        throw new Error('PVE API POST /nodes/pve-01/lxc/200/status/start returned 403: Permission denied (VM.PowerMgmt)');
      }
      return [];
    });
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    await assert.rejects(
      () => r.performAction('pve-01/200', 'start'),
      /Permission denied \(VM\.PowerMgmt\)/,
    );
  });

  it('returns success even when PVE returns no UPID (no trailing UPID part in message)', async () => {
    const { transport } = fakeRestTransport(call => {
      if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
      if (call.path === '/cluster/resources') return CLUSTER_RESOURCES;
      // Some PVE error responses with status 200 return null in .data.
      if (call.kind === 'action') return null;
      return [];
    });
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ allowActions: true, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const result = await r.performAction('pve-01/200', 'start');
    assert.equal(result.status, 'success');
    assert.doesNotMatch(result.message, /UPID:/);
  });
});
