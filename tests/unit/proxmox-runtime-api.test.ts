import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { ProxmoxRuntime } = require('../../agent/src/runtime/proxmox');
const { __setTestTransport } = require('../../agent/src/runtime/pveApi');
const { LogsUnavailableError } = require('../../agent/src/runtime/types');

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

  it('fetchLogs throws LogsUnavailableError in REST mode (LXC and QEMU)', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    // The custom error type is what the MQTT dispatcher and UI key off to
    // render a calm empty state instead of treating this as a fetch failure.
    const lxcErr = await r.fetchLogs('lxc/200', { lines: 50 }).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(lxcErr instanceof LogsUnavailableError, 'expected LogsUnavailableError for LXC');
    assert.match(lxcErr!.message, /Logs are not available when insightd reads PVE via REST API.*Install insightd-agent inside the guest/i);

    const qemuErr = await r.fetchLogs('qemu/103', { lines: 50 }).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(qemuErr instanceof LogsUnavailableError, 'expected LogsUnavailableError for QEMU');
    assert.match(qemuErr!.message, /Install insightd-agent inside the guest/i);
  });

  it('checkImageUpdates is a no-op array (same as local mode)', async () => {
    const { transport } = fakeRestTransport(() => CLUSTER_STATUS_REMOTE);
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    assert.deepEqual(await r.checkImageUpdates(), []);
  });

  it('getHostMetrics maps /nodes/{node}/status into the override shape', async () => {
    const { transport } = fakeRestTransport(call => {
      if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
      if (call.path === '/nodes/pve-01/status') {
        return {
          uptime: 11_706_361,
          cpu: 0.318103241296519,
          loadavg: ['1.16', '1.46', '1.65'],
          memory: { total: 33_465_860_096, used: 25_465_696_256, free: 1_052_426_240 },
          swap:   { total:  8_589_930_496, used:  8_577_904_640 },
          rootfs: { total: 241_928_577_024, used: 229_581_828_096, avail: 1_729_884_160 },
        };
      }
      return [];
    });
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const m = await r.getHostMetrics();
    assert.ok(m, 'expected a metrics override in REST mode');
    assert.equal(m!.uptimeSeconds, 11_706_361);
    assert.equal(m!.cpuPercent, 31.81);
    assert.equal(m!.load1, 1.16);
    assert.equal(m!.load15, 1.65);
    // 33_465_860_096 / 1024 / 1024 ≈ 31_915.07 MiB
    assert.ok(m!.memoryTotalMb! > 31_900 && m!.memoryTotalMb! < 31_930, `unexpected memTotalMb: ${m!.memoryTotalMb}`);
    assert.ok(m!.swapTotalMb! > 8_100 && m!.swapTotalMb! < 8_200, `unexpected swapTotalMb: ${m!.swapTotalMb}`);
  });

  it('getDiskMetrics returns the rootfs entry from /nodes/{node}/status', async () => {
    const { transport } = fakeRestTransport(call => {
      if (call.path === '/cluster/status') return CLUSTER_STATUS_REMOTE;
      if (call.path === '/nodes/pve-01/status') {
        return { rootfs: { total: 241_928_577_024, used: 229_581_828_096, avail: 1_729_884_160 } };
      }
      return [];
    });
    __setTestTransport(transport);
    const r = new ProxmoxRuntime({ api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    await r.init();
    const disks = await r.getDiskMetrics();
    assert.ok(disks && disks.length === 1, 'expected one rootfs entry');
    assert.equal(disks![0].mountPoint, '/');
    assert.ok(disks![0].usedPercent > 90, `rootfs is 95% full per fixture, got ${disks![0].usedPercent}`);
  });

  it('getHostMetrics + getDiskMetrics return null in local-shell mode (so /proc wins)', async () => {
    const { ProxmoxRuntime: PR } = require('../../agent/src/runtime/proxmox');
    // No `api` config → local-shell transport → both methods short-circuit.
    const r = new PR({ nodeName: 'pve-01' });
    assert.equal(await r.getHostMetrics(), null);
    assert.equal(await r.getDiskMetrics(), null);
  });

  it('reports supportsActions=true regardless of allowActions (capability vs authorization)', () => {
    const r = new ProxmoxRuntime({ allowActions: false, api: { url: 'https://pve.lan:8006' }, nodeName: 'pve-01' });
    assert.equal(r.supportsActions, true);
    assert.equal(r.name, 'proxmox');
  });
});
