import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const child_process = require('child_process');

/**
 * Mocks pvesh by stubbing child_process.execFile (the lazy-require pattern
 * used by agent/src/runtime/pvesh.ts means each call sees the current
 * mock — see PR1 lessons learned).
 */
function loadCollectors(stub: (path: string) => string | null): typeof import('../../agent/src/collectors/proxmox-cluster') {
  mock.method(child_process, 'execFile', (
    _file: string, args: string[], _options: any,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const path = args[1];
    try {
      const out = stub(path);
      if (out === null) cb(new Error('pvesh: 500 internal error'), '', '');
      else cb(null, out, '');
    } catch (err) {
      cb(err as Error, '', '');
    }
  });
  delete require.cache[require.resolve('../../agent/src/collectors/proxmox-cluster')];
  return require('../../agent/src/collectors/proxmox-cluster');
}

describe('collectStoragePools', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('maps pvesh /nodes/{node}/storage to the typed shape', async () => {
    const { collectStoragePools } = loadCollectors(() => JSON.stringify([
      { storage: 'local', type: 'dir', total: 100_000_000_000, used: 30_000_000_000, active: 1, shared: 0 },
      { storage: 'local-zfs', type: 'zfspool', total: 1_000_000_000_000, used: 200_000_000_000, active: 1, shared: 0 },
      { storage: 'shared-rbd', type: 'rbd', total: 5_000_000_000_000, used: 1_500_000_000_000, active: 1, shared: 1 },
    ]));
    const pools = await collectStoragePools('pve-01');
    assert.equal(pools.length, 3);
    assert.equal(pools[0].storageName, 'local');
    assert.equal(pools[0].active, true);
    assert.equal(pools[0].shared, false);
    assert.equal(pools[2].shared, true);
  });

  it('coerces zero-total storages to null so divide-by-zero stays out of the alert path', async () => {
    const { collectStoragePools } = loadCollectors(() => JSON.stringify([
      // PVE returns zero for inactive/disconnected storages — saturation
      // checks must not interpret those as "full".
      { storage: 'detached-nfs', type: 'nfs', total: 0, used: 0, active: 0, shared: 1 },
    ]));
    const pools = await collectStoragePools('pve-01');
    assert.equal(pools[0].totalBytes, null);
    assert.equal(pools[0].active, false);
  });
});

describe('collectZfsPools', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('maps the pvesh shape and surfaces health verbatim', async () => {
    const { collectZfsPools } = loadCollectors(() => JSON.stringify([
      { name: 'rpool', health: 'ONLINE', size: 1_000_000_000_000, alloc: 200_000_000_000, free: 800_000_000_000, frag: 12, dedup: 1.0 },
      { name: 'tank', health: 'DEGRADED', size: 5_000_000_000_000, alloc: 4_500_000_000_000, frag: 65, dedup: 1.4 },
    ]));
    const pools = await collectZfsPools('pve-01');
    assert.equal(pools.length, 2);
    assert.equal(pools[0].health, 'ONLINE');
    assert.equal(pools[1].health, 'DEGRADED');
    assert.equal(pools[1].fragmentation, 65);
    assert.equal(pools[1].dedupRatio, 1.4);
    // last_scrub_at not exposed by /disks/zfs in v1 — explicitly null.
    assert.equal(pools[0].lastScrubAt, null);
  });

  it('returns [] (not throw) when ZFS is not installed on this PVE node', async () => {
    // PVE returns an error from `zpool list` on hosts without ZFS — the
    // collector should treat that as "no pools" rather than failing the
    // whole collection cycle (other PVE signals must still publish).
    const { collectZfsPools } = loadCollectors(() => null);
    const pools = await collectZfsPools('pve-01');
    assert.deepEqual(pools, []);
  });
});

describe('collectClusterStatus', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('extracts quorate + node counts from /cluster/status', async () => {
    const { collectClusterStatus } = loadCollectors(() => JSON.stringify([
      { type: 'cluster', name: 'home', quorate: 1, nodes: 3 },
      { type: 'node', name: 'pve-01', local: 1, online: 1 },
      { type: 'node', name: 'pve-02', local: 0, online: 1 },
      { type: 'node', name: 'pve-03', local: 0, online: 0 },
    ]));
    const status = await collectClusterStatus();
    assert.ok(status);
    assert.equal(status.clusterName, 'home');
    assert.equal(status.quorate, true);
    assert.equal(status.totalNodes, 3);
    assert.equal(status.onlineNodes, 2);
  });

  it('returns null on standalone PVE (no cluster row)', async () => {
    // Single-node installs publish no cluster row — the collector returns
    // null so the publisher short-circuits and the hub never sees a phantom
    // "cluster of one" that could spuriously alert.
    const { collectClusterStatus } = loadCollectors(() => JSON.stringify([
      { type: 'node', name: 'pve-01', local: 1, online: 1 },
    ]));
    assert.equal(await collectClusterStatus(), null);
  });

  it('reports quorate=false when corosync has lost quorum', async () => {
    const { collectClusterStatus } = loadCollectors(() => JSON.stringify([
      { type: 'cluster', name: 'home', quorate: 0, nodes: 3 },
      { type: 'node', name: 'pve-01', local: 1, online: 1 },
    ]));
    const status = await collectClusterStatus();
    assert.equal(status?.quorate, false);
    assert.equal(status?.onlineNodes, 1);
  });
});

describe('collectGuestSnapshots', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  it('summarizes per-guest snapshot lists, skipping the synthetic "current" entry', async () => {
    const { collectGuestSnapshots } = loadCollectors((path) => {
      if (path.endsWith('/qemu/103/snapshot')) {
        return JSON.stringify([
          { name: 'current', parent: 'pre-upgrade' },
          { name: 'pre-upgrade', snaptime: 1_700_000_000 },
          { name: 'baseline', snaptime: 1_690_000_000 },
        ]);
      }
      if (path.endsWith('/lxc/200/snapshot')) {
        return JSON.stringify([{ name: 'current' }]);
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const out = await collectGuestSnapshots('pve-01', [
      { vmid: 103, type: 'qemu' },
      { vmid: 200, type: 'lxc' },
    ]);
    assert.equal(out.length, 2);
    const qemu = out.find(o => o.guestVmid === 103)!;
    assert.equal(qemu.snapshotCount, 2);
    assert.equal(qemu.oldestAt, new Date(1_690_000_000 * 1000).toISOString());
    assert.equal(qemu.newestAt, new Date(1_700_000_000 * 1000).toISOString());
    const lxc = out.find(o => o.guestVmid === 200)!;
    assert.equal(lxc.snapshotCount, 0);
    assert.equal(lxc.oldestAt, null);
  });

  it('skips a single failing guest without sinking the whole batch', async () => {
    const { collectGuestSnapshots } = loadCollectors((path) => {
      if (path.endsWith('/qemu/103/snapshot')) {
        // Simulate VM destroyed mid-cycle — pvesh returns an error.
        throw new Error('VM 103 - no such VM');
      }
      if (path.endsWith('/lxc/200/snapshot')) {
        return JSON.stringify([{ name: 'current' }, { name: 'snap1', snaptime: 1_700_000_000 }]);
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const out = await collectGuestSnapshots('pve-01', [
      { vmid: 103, type: 'qemu' },
      { vmid: 200, type: 'lxc' },
    ]);
    // Only the LXC row survives; the failing QEMU one is silently dropped.
    assert.equal(out.length, 1);
    assert.equal(out[0].guestVmid, 200);
  });
});

describe('collectGuestBackups', () => {
  beforeEach(() => mock.restoreAll());
  afterEach(() => mock.restoreAll());

  function tasksAndNotBackedUp(tasks: any[], notBackedUp: any[] = []) {
    return (path: string): string => {
      if (path === '/cluster/tasks') return JSON.stringify(tasks);
      if (path === '/cluster/backup-info/not-backed-up') return JSON.stringify(notBackedUp);
      throw new Error(`unexpected path: ${path}`);
    };
  }

  it('returns the most recent successful vzdump per VMID', async () => {
    const { collectGuestBackups } = loadCollectors(tasksAndNotBackedUp([
      // Newer success for 103 should win over older success on the same vmid.
      { type: 'vzdump', id: '103', endtime: 1_700_000_000, status: 'OK' },
      { type: 'vzdump', id: '103', endtime: 1_690_000_000, status: 'OK' },
      // An LXC backup with the qmid prefix format.
      { type: 'vzdump', id: 'lxc/200', endtime: 1_700_000_000, status: 'OK' },
      // Non-vzdump task should be ignored.
      { type: 'qmstart', id: '103', endtime: 1_701_000_000, status: 'OK' },
    ]));
    const out = await collectGuestBackups([
      { vmid: 103, type: 'qemu' },
      { vmid: 200, type: 'lxc' },
    ]);
    assert.equal(out.length, 2);
    const qemu = out.find(o => o.guestVmid === 103)!;
    assert.equal(qemu.lastBackupAt, new Date(1_700_000_000 * 1000).toISOString());
    assert.equal(qemu.lastStatus, 'OK');
    const lxc = out.find(o => o.guestVmid === 200)!;
    assert.equal(lxc.lastStatus, 'OK');
  });

  it('reports last_status=FAILED when the most recent vzdump errored', async () => {
    const { collectGuestBackups } = loadCollectors(tasksAndNotBackedUp([
      { type: 'vzdump', id: '103', endtime: 1_700_000_000, status: 'failed: insufficient space' },
    ]));
    const out = await collectGuestBackups([{ vmid: 103, type: 'qemu' }]);
    assert.equal(out[0].lastStatus, 'FAILED');
  });

  it('falls back to /cluster/backup-info/not-backed-up for guests with no task history', async () => {
    const { collectGuestBackups } = loadCollectors(tasksAndNotBackedUp(
      [],
      [{ vmid: 103, type: 'qemu', name: 'fresh-vm' }],
    ));
    const out = await collectGuestBackups([{ vmid: 103, type: 'qemu' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].lastStatus, 'NEVER');
    assert.equal(out[0].lastBackupAt, null);
  });

  it('skips guests not present on this node so backup history for migrated VMs does not leak in', async () => {
    const { collectGuestBackups } = loadCollectors(tasksAndNotBackedUp([
      { type: 'vzdump', id: '999', endtime: 1_700_000_000, status: 'OK' },
    ]));
    const out = await collectGuestBackups([{ vmid: 103, type: 'qemu' }]);
    // 999 isn't in the present list; not-backed-up was empty too.
    assert.deepEqual(out, []);
  });

  it('returns [] when no guests are present (no pvesh calls)', async () => {
    let called = false;
    const { collectGuestBackups } = loadCollectors(() => { called = true; return '[]'; });
    assert.deepEqual(await collectGuestBackups([]), []);
    assert.equal(called, false, 'should short-circuit before pvesh');
  });
});
