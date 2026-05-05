import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { __setTestTransport } = require('../../agent/src/runtime/pveApi');

/**
 * Cluster collector tests in REST mode. Same fixtures as
 * collectors-proxmox-cluster.test.ts, but going through the Transport
 * abstraction with a fake REST transport instead of mocking child_process.
 *
 * Validates that the unwrap layer (`{data: [...]}` → `[...]`) is applied
 * by the transport, so the collectors' downstream parsing is identical
 * regardless of mode.
 */

interface RecordedCall {
  kind: 'get' | 'action';
  path: string;
}

function fakeRestTransport(stub: (path: string) => unknown): { transport: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    transport: {
      mode: 'rest-api',
      async get(path: string) {
        calls.push({ kind: 'get', path });
        const out = stub(path);
        if (out instanceof Error) throw out;
        return out;
      },
      async action() {
        throw new Error('REST collector tests should not invoke action()');
      },
    },
  };
}

describe('proxmox-cluster collectors — REST mode', () => {
  beforeEach(() => __setTestTransport(null));
  afterEach(() => __setTestTransport(null));

  it('collectStoragePools: REST transport returns unwrapped data identical to local mode', async () => {
    const { transport, calls } = fakeRestTransport(path => {
      if (path === '/nodes/pve-01/storage') {
        return [
          { storage: 'local', type: 'dir', total: 100_000_000_000, used: 30_000_000_000, active: 1, shared: 0 },
          { storage: 'local-zfs', type: 'zfspool', total: 1_000_000_000_000, used: 200_000_000_000, active: 1, shared: 0 },
        ];
      }
      throw new Error(`unexpected path: ${path}`);
    });
    __setTestTransport(transport);

    const { collectStoragePools } = require('../../agent/src/collectors/proxmox-cluster');
    const pools = await collectStoragePools('pve-01');
    assert.equal(pools.length, 2);
    assert.equal(pools[0].storageName, 'local');
    assert.equal(pools[0].active, true);
    // The collector called the REST transport once with the right path.
    assert.deepEqual(calls.map(c => c.path), ['/nodes/pve-01/storage']);
  });

  it('collectZfsPools: returns [] when REST transport throws (host without ZFS)', async () => {
    const { transport } = fakeRestTransport(() => new Error('PVE API GET /nodes/pve-01/disks/zfs returned 500: zpool list failed'));
    __setTestTransport(transport);
    const { collectZfsPools } = require('../../agent/src/collectors/proxmox-cluster');
    const pools = await collectZfsPools('pve-01');
    // Same calm fallback as local mode — one bad endpoint shouldn't sink the whole cycle.
    assert.deepEqual(pools, []);
  });

  it('collectClusterStatus: extracts quorate + node counts from REST response', async () => {
    const { transport } = fakeRestTransport(path => {
      if (path === '/cluster/status') {
        return [
          { type: 'cluster', name: 'home', quorate: 1, nodes: 3 },
          { type: 'node', name: 'pve-01', online: 1 },
          { type: 'node', name: 'pve-02', online: 1 },
          { type: 'node', name: 'pve-03', online: 0 },
        ];
      }
      throw new Error(`unexpected path: ${path}`);
    });
    __setTestTransport(transport);
    const { collectClusterStatus } = require('../../agent/src/collectors/proxmox-cluster');
    const status = await collectClusterStatus();
    assert.equal(status.clusterName, 'home');
    assert.equal(status.quorate, true);
    assert.equal(status.totalNodes, 3);
    assert.equal(status.onlineNodes, 2);
  });

  it('collectGuestSnapshots: per-guest fan-out routes one REST call per vmid', async () => {
    const calledPaths: string[] = [];
    const { transport } = fakeRestTransport(path => {
      calledPaths.push(path);
      if (path.endsWith('/qemu/103/snapshot')) {
        return [
          { name: 'current', parent: 'pre-upgrade' },
          { name: 'pre-upgrade', snaptime: 1_700_000_000 },
        ];
      }
      if (path.endsWith('/lxc/200/snapshot')) {
        return [{ name: 'current' }];
      }
      throw new Error(`unexpected path: ${path}`);
    });
    __setTestTransport(transport);
    const { collectGuestSnapshots } = require('../../agent/src/collectors/proxmox-cluster');
    const out = await collectGuestSnapshots('pve-01', [
      { vmid: 103, type: 'qemu' },
      { vmid: 200, type: 'lxc' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(calledPaths.sort(), [
      '/nodes/pve-01/lxc/200/snapshot',
      '/nodes/pve-01/qemu/103/snapshot',
    ]);
    const qemu = out.find((o: any) => o.guestVmid === 103);
    assert.equal(qemu.snapshotCount, 1);
  });

  it('collectGuestBackups: REST transport gives the same shape as local — calls /cluster/tasks', async () => {
    const { transport } = fakeRestTransport(path => {
      if (path === '/cluster/tasks') {
        return [
          { type: 'vzdump', id: '103', endtime: 1_700_000_000, status: 'OK' },
          { type: 'vzdump', id: '103', endtime: 1_690_000_000, status: 'OK' },
          { type: 'qmstart', id: '200', endtime: 1_701_000_000, status: 'OK' },
        ];
      }
      if (path === '/cluster/backup-info/not-backed-up') return [];
      throw new Error(`unexpected path: ${path}`);
    });
    __setTestTransport(transport);
    const { collectGuestBackups } = require('../../agent/src/collectors/proxmox-cluster');
    const out = await collectGuestBackups([
      { vmid: 103, type: 'qemu' },
      { vmid: 200, type: 'lxc' },
    ]);
    // 200 wasn't in vzdump tasks AND wasn't in not-backed-up — skipped.
    // 103 picked the newer of two OK rows.
    assert.equal(out.length, 1);
    assert.equal(out[0].guestVmid, 103);
    assert.equal(out[0].lastStatus, 'OK');
  });
});
