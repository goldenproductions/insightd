import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { ProxmoxRuntime } = require('../../agent/src/runtime/proxmox');
const { __setTestTransport } = require('../../agent/src/runtime/pveApi');

/**
 * REST-mode tests inject a fake Transport via the __setTestTransport hook
 * exported from pveApi.ts. That avoids mocking https.request and keeps the
 * tests focused on ProxmoxRuntime's behavior in REST mode (init validates
 * INSIGHTD_PVE_NODE, fetchLogs throws the in-guest-agent message, etc).
 *
 * Lower-level HTTP wire format (auth header, URL building, .data unwrap)
 * is exercised separately in proxmox-actions-api.test.ts via the same hook.
 */

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
  { type: 'node', name: 'pve-01', online: 1 },  // no `local=1` — we're remote
  { type: 'node', name: 'pve-02', online: 1 },
];

describe('ProxmoxRuntime — REST API mode', () => {
  beforeEach(() => __setTestTransport(null));
  afterEach(() => __setTestTransport(null));

  it('init() resolves nodeName from INSIGHTD_PVE_NODE (no local=1 row remotely)', async () => {
    const { transport } = fakeRestTransport(call =>
      call.path === '/cluster/status' ? CLUSTER_STATUS_REMOTE : []
    );
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    assert.equal(r.nodeName, 'pve-01');
  });

  it('init() throws when INSIGHTD_PVE_NODE is missing in REST mode', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' } /* no nodeName */ });
    await assert.rejects(() => r.init(), /requires INSIGHTD_PVE_NODE/);
  });

  it('init() throws when the configured node name is not in the cluster', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'typo-04' });
    await assert.rejects(() => r.init(), /typo-04.*not found.*Known nodes: pve-01, pve-02/);
  });

  it('listContainers filters by configured node + maps the same fields as local mode', async () => {
    const { transport } = fakeRestTransport(call => {
      if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
      if (call.path === '/cluster/resources') {
        return [
          { type: 'lxc', id: 'lxc/200', node: 'pve-01', vmid: 200, name: 'web', status: 'running', uptime: 3600 },
          { type: 'qemu', id: 'qemu/103', node: 'pve-01', vmid: 103, name: 'db', status: 'stopped' },
          { type: 'qemu', id: 'qemu/999', node: 'pve-02', vmid: 999, name: 'other', status: 'running' },
          { type: 'qemu', id: 'qemu/9000', node: 'pve-01', vmid: 9000, name: 'tmpl', template: 1 },
        ];
      }
      return [];
    });
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const list = await r.listContainers();
    // pve-02's guest is filtered out, the template is filtered out.
    const names = list.map((c: any) => c.name).sort();
    assert.deepEqual(names, ['pve-01/103', 'pve-01/200']);
    const lxc = list.find((c: any) => c.guestVmid === 200);
    assert.equal(lxc.guestType, 'lxc');
    assert.equal(lxc.status, 'running');
    assert.equal(lxc.guestUptimeSeconds, 3600);
  });

  it('fetchLogs throws the in-guest-agent message in REST mode (LXC and QEMU)', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    // Same error for both — the UI uses this to render the empty state.
    await assert.rejects(
      () => r.fetchLogs('lxc/200', { lines: 50 }),
      /Logs are not available when insightd reads PVE via REST API.*Install insightd-agent inside the guest/i,
    );
    await assert.rejects(
      () => r.fetchLogs('qemu/103', { lines: 50 }),
      /Install insightd-agent inside the guest/i,
    );
  });

  it('checkImageUpdates is a no-op array (same as local mode)', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    assert.deepEqual(await r.checkImageUpdates(), []);
  });

  it('reports supportsActions=true regardless of allowActions (capability vs authorization)', () => {
    const r = new ProxmoxRuntime({ allowActions: false, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    assert.equal(r.supportsActions, true);
    assert.equal(r.name, 'proxmox');
  });
});
