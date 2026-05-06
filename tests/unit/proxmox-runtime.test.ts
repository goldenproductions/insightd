import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const child_process = require('child_process');

/**
 * ProxmoxRuntime is a thin wrapper around `pvesh get … --output-format json`,
 * so the tests stub `child_process.execFile` and feed canned PVE responses.
 *
 * The pattern mirrors gpu.test.ts: mock first, then delete the module from
 * the require cache so `promisify(execFile)` captures the mocked function.
 */
function loadProxmox(stub: (path: string) => string): typeof import('../../agent/src/runtime/proxmox') {
  // execFile callback signature: (file, args, options?, cb)
  mock.method(child_process, 'execFile', (
    _file: string,
    args: string[],
    _options: any,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // pvesh args: ['get', '<path>', '--output-format', 'json']
    const pathArg = args[1];
    try {
      cb(null, stub(pathArg), '');
    } catch (err) {
      cb(err as Error, '', '');
    }
  });
  delete require.cache[require.resolve('../../agent/src/runtime/proxmox')];
  return require('../../agent/src/runtime/proxmox');
}

const FIXTURE_NODE = 'proxmox-01';

const CLUSTER_STATUS = JSON.stringify([
  { type: 'cluster', name: 'home', quorate: 1 },
  { type: 'node', name: 'proxmox-01', local: 1, online: 1 },
  { type: 'node', name: 'proxmox-02', local: 0, online: 1 },
]);

const CLUSTER_RESOURCES = JSON.stringify([
  // LXC running on this node — should appear.
  {
    type: 'lxc', id: 'lxc/200', node: FIXTURE_NODE, vmid: 200, name: 'web',
    status: 'running', uptime: 86400, cpu: 0.05, maxcpu: 2,
    mem: 256 * 1024 * 1024, maxmem: 512 * 1024 * 1024,
    netin: 1000, netout: 2000, diskread: 3000, diskwrite: 4000,
    tags: 'prod;web',
  },
  // QEMU stopped on this node — should appear with null metrics.
  {
    type: 'qemu', id: 'qemu/103', node: FIXTURE_NODE, vmid: 103, name: 'db',
    status: 'stopped', uptime: 0, cpu: 0, maxcpu: 4,
    mem: 0, maxmem: 4096 * 1024 * 1024,
  },
  // QEMU running on a *different* node — should be filtered out.
  {
    type: 'qemu', id: 'qemu/999', node: 'proxmox-02', vmid: 999, name: 'other-node-vm',
    status: 'running', cpu: 0.5, maxcpu: 2, mem: 100, maxmem: 1024,
  },
  // Template — should be skipped (always shows as stopped, not a workload).
  {
    type: 'qemu', id: 'qemu/9000', node: FIXTURE_NODE, vmid: 9000, name: 'debian-template',
    status: 'stopped', template: 1,
  },
  // Storage / node rows — should be filtered out.
  { type: 'storage', id: 'storage/proxmox-01/local', node: FIXTURE_NODE, status: 'available' },
  { type: 'node', id: 'node/proxmox-01', node: FIXTURE_NODE, status: 'online' },
]);

function defaultStub(path: string): string {
  if (path === '/cluster/status') return CLUSTER_STATUS;
  if (path === '/cluster/resources') return CLUSTER_RESOURCES;
  throw new Error(`unexpected pvesh path: ${path}`);
}

describe('ProxmoxRuntime', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('init() resolves the local PVE node name from /cluster/status', async () => {
    const { ProxmoxRuntime } = loadProxmox(defaultStub);
    const r = new ProxmoxRuntime();
    await r.init();
    // listContainers uses the resolved node to filter — proves init wired up.
    const list = await r.listContainers();
    // proxmox-02's VM is filtered out; templates and storage rows too.
    const names = list.map(c => c.name).sort();
    assert.deepEqual(names, ['proxmox-01/db', 'proxmox-01/web']);
  });

  it('listContainers maps lxc/qemu rows to ContainerInfo with guest fields', async () => {
    const { ProxmoxRuntime } = loadProxmox(defaultStub);
    const r = new ProxmoxRuntime();
    await r.init();
    const list = await r.listContainers();
    const lxc = list.find(c => c.guestVmid === 200)!;
    assert.equal(lxc.guestType, 'lxc');
    assert.equal(lxc.status, 'running');
    assert.equal(lxc.guestUptimeSeconds, 86400);
    assert.equal(lxc.id, 'lxc/200');
    assert.equal(lxc.image, 'lxc');
    // Tags surface as a label so existing label-based filters can act on them.
    assert.equal(lxc.labels['insightd.pve.tags'], 'prod;web');
    assert.equal(lxc.labels['insightd.pve.type'], 'lxc');
    assert.equal(lxc.labels['insightd.pve.node'], FIXTURE_NODE);

    const qemu = list.find(c => c.guestVmid === 103)!;
    assert.equal(qemu.guestType, 'qemu');
    // PVE 'stopped' maps to Docker's 'exited' so the existing dashboard
    // status rules (running = up, anything else = down) keep working.
    assert.equal(qemu.status, 'exited');
  });

  it('collectResources enriches running guests and nulls out stopped ones', async () => {
    const { ProxmoxRuntime } = loadProxmox(defaultStub);
    const r = new ProxmoxRuntime();
    await r.init();
    const list = await r.listContainers();
    const enriched = await r.collectResources(list);

    const lxc = enriched.find(c => c.guestVmid === 200)!;
    // 0.05 cpu fraction → 5%
    assert.equal(lxc.cpuPercent, 5);
    // 256 MiB mem → 256 MB (bytes/1024/1024)
    assert.equal(lxc.memoryMb, 256);
    assert.equal(lxc.memoryLimitMb, 512);
    assert.equal(lxc.cpuLimitCores, 2);
    assert.equal(lxc.networkRxBytes, 1000);
    assert.equal(lxc.networkTxBytes, 2000);
    assert.equal(lxc.blkioReadBytes, 3000);
    assert.equal(lxc.blkioWriteBytes, 4000);

    const qemu = enriched.find(c => c.guestVmid === 103)!;
    // Stopped guest — PVE returns 0 for cpu/mem/io; surfacing those as live
    // numbers would mislead the dashboard's "memory at 0" baseline.
    assert.equal(qemu.cpuPercent, null);
    assert.equal(qemu.memoryMb, null);
    assert.equal(qemu.networkRxBytes, null);
    // Limits are still meaningful — surface them so capacity views work.
    assert.equal(qemu.memoryLimitMb, 4096);
    assert.equal(qemu.cpuLimitCores, 4);
  });

  it('checkImageUpdates returns an empty array (no image concept for VMs/LXC)', async () => {
    const { ProxmoxRuntime } = loadProxmox(defaultStub);
    const r = new ProxmoxRuntime();
    await r.init();
    assert.deepEqual(await r.checkImageUpdates(), []);
  });

  it('init() throws a descriptive error when pvesh is unavailable', async () => {
    const { ProxmoxRuntime } = loadProxmox(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const r = new ProxmoxRuntime();
    await assert.rejects(() => r.init(), /ProxmoxRuntime init failed/);
  });

  it('advertises supportsActions=true (PR4 capability) and supportsUpdateChecks=false', async () => {
    // supportsActions is a capability flag — true even when allowActions=false
    // so the UI doesn't claim the runtime can't do actions; the agent's own
    // allowActions guard returns the actionable error.
    const { ProxmoxRuntime } = loadProxmox(defaultStub);
    const r = new ProxmoxRuntime();
    assert.equal(r.supportsActions, true);
    assert.equal(r.supportsUpdateChecks, false);
    assert.equal(r.name, 'proxmox');
  });
});
