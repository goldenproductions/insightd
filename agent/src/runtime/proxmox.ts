import os = require('os');
import logger = require('../../../shared/utils/logger');
import type {
  ContainerRuntime, ContainerInfo, ContainerWithResources,
  LogEntry, LogOptions, ContainerAction, ActionResult, ImageUpdate,
} from './types';

const PVESH_PATH = '/usr/bin/pvesh';
const PVESH_TIMEOUT_MS = 10_000;

/**
 * `pvesh get /cluster/resources --output-format json` returns one row per
 * cluster resource. We only consume the subset we need; PVE adds fields
 * across versions and we shouldn't fail if a column we don't care about
 * goes missing.
 */
interface PveResource {
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'pool' | 'sdn';
  id: string;            // e.g. "qemu/103", "lxc/200", "node/proxmox-01"
  node: string;
  vmid?: number;         // qemu/lxc only
  name?: string;         // qemu/lxc display name
  status?: string;       // running | stopped | unknown | ...
  template?: number;     // 1 if a template (skip)
  uptime?: number;       // seconds
  cpu?: number;          // 0..1 fraction of total cores
  maxcpu?: number;
  mem?: number;          // bytes
  maxmem?: number;
  netin?: number;        // total bytes since guest start
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  tags?: string;         // semicolon-separated
}

interface PveClusterStatusRow {
  type: string;
  name?: string;
  local?: number;
}

/**
 * Proxmox VE implementation of ContainerRuntime.
 *
 * Treats LXC containers and QEMU VMs as `ContainerInfo` rows so they show up
 * in the existing Hosts page / container UI without inventing a parallel
 * "guests" surface. The PVE host itself is a regular host_snapshot — `/proc`
 * collectors work natively on PVE (it's just Debian) so getHostMetrics is
 * not implemented.
 *
 * PR 1 scope: list + resource collection only. Logs, actions, and the
 * cluster-scoped collectors (storage, ZFS, backups, snapshots) land in
 * later PRs.
 */
export class ProxmoxRuntime implements ContainerRuntime {
  readonly name = 'proxmox' as const;
  readonly supportsActions = false;       // enabled in PR 4
  readonly supportsUpdateChecks = false;  // not meaningful for VMs/LXC

  /** PVE node name as PVE itself sees it (cluster/status local=1 row). */
  private nodeName: string = os.hostname();

  /** In-cycle cache so listContainers and collectResources share one pvesh call. */
  private resourceCache = new Map<string, PveResource>();

  async init(): Promise<void> {
    // Confirm pvesh is reachable. A clear error here beats an obscure ENOENT
    // on every collection cycle.
    try {
      const status = await pvesh<PveClusterStatusRow[]>('/cluster/status');
      const local = status.find(r => r.type === 'node' && r.local === 1);
      if (local?.name) this.nodeName = local.name;
      logger.info('proxmox', `Connected via pvesh — local node: ${this.nodeName}`);
    } catch (err) {
      throw new Error(`ProxmoxRuntime init failed: ${(err as Error).message}`);
    }
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const resources = await pvesh<PveResource[]>('/cluster/resources');
    this.resourceCache.clear();

    const guests: ContainerInfo[] = [];
    for (const r of resources) {
      if (r.type !== 'lxc' && r.type !== 'qemu') continue;
      // Templates aren't running workloads — skip; they'd otherwise show as
      // permanently "stopped" guests on every host detail page.
      if (r.template === 1) continue;
      // Scope to this node. PVE clusters publish all nodes' guests on every
      // node; we only want the ones running here so the host_id stays correct.
      if (r.node !== this.nodeName) continue;

      this.resourceCache.set(r.id, r);
      guests.push({
        // Stable cluster-wide identifier — matches the label format the
        // in-guest agent stamps via INSIGHTD_PROXMOX_NODE/_VMID for the
        // identity bridge in PR 4.
        name: `${r.node}/${r.vmid}`,
        id: r.id,                                                // "lxc/200"
        status: mapStatus(r.status),
        restartCount: 0,                                         // no concept on PVE
        healthStatus: null,                                      // no concept
        labels: buildLabels(r),
        image: r.type === 'qemu' ? 'qemu' : 'lxc',
        guestType: r.type === 'qemu' ? 'qemu' : 'lxc',
        guestVmid: r.vmid ?? null,
        guestUptimeSeconds: r.uptime ?? null,
      });
    }
    return guests;
  }

  async collectResources(containers: ContainerInfo[]): Promise<ContainerWithResources[]> {
    const enriched: ContainerWithResources[] = containers.map(c => {
      const r = this.resourceCache.get(c.id);
      // Stopped guests don't have meaningful CPU/mem in /cluster/resources;
      // PVE returns 0 for both. Surface as null so the dashboard treats the
      // row the same way it does a stopped Docker container.
      const isRunning = c.status === 'running';
      const cpuPercent = isRunning && r && typeof r.cpu === 'number'
        ? Math.round(r.cpu * 100 * 100) / 100  // fraction → percent, 2dp
        : null;
      const memoryMb = isRunning && r && typeof r.mem === 'number'
        ? Math.round(r.mem / (1024 * 1024) * 10) / 10
        : null;
      const memoryLimitMb = r && typeof r.maxmem === 'number' && r.maxmem > 0
        ? Math.round(r.maxmem / (1024 * 1024))
        : null;
      return {
        ...c,
        cpuPercent,
        memoryMb,
        // PVE reports total bytes since guest start — same shape as Docker's
        // network counters; the hub's per-cycle delta math handles the rest.
        networkRxBytes: isRunning ? (r?.netin ?? null) : null,
        networkTxBytes: isRunning ? (r?.netout ?? null) : null,
        blkioReadBytes: isRunning ? (r?.diskread ?? null) : null,
        blkioWriteBytes: isRunning ? (r?.diskwrite ?? null) : null,
        cpuLimitCores: r && typeof r.maxcpu === 'number' && r.maxcpu > 0 ? r.maxcpu : null,
        memoryLimitMb,
      };
    });
    return enriched;
  }

  async fetchLogs(_containerId: string, _options: LogOptions): Promise<LogEntry[]> {
    // LXC: journalctl --machine=<vmid> / pct exec — wired up in PR 4.
    // QEMU: no host-side logs available, requires in-guest agent.
    throw new Error('Log fetch for Proxmox guests is not implemented yet (planned for PR 4)');
  }

  async performAction(_containerName: string, _action: ContainerAction): Promise<ActionResult> {
    throw new Error('Container actions for Proxmox guests are not implemented yet (planned for PR 4)');
  }

  async checkImageUpdates(): Promise<ImageUpdate[]> {
    // No "image" concept for VMs/LXC. Returning an empty array is the contract.
    return [];
  }
}

/**
 * Map PVE's status field to the same vocabulary Docker uses, so the existing
 * dashboard rules ("running" = up, anything else = down) keep working.
 */
function mapStatus(pveStatus: string | undefined): string {
  switch (pveStatus) {
    case 'running': return 'running';
    case 'stopped': return 'exited';
    case 'paused':  return 'paused';
    default: return pveStatus || 'unknown';
  }
}

/**
 * PVE tags are a free-form, semicolon-separated list. Surface them as labels
 * so the existing namespace/label filters can act on them. The `insightd.pve.*`
 * prefix is reserved for fields the diagnoser keys off of.
 */
function buildLabels(r: PveResource): Record<string, string> {
  const labels: Record<string, string> = {
    'insightd.pve.type': r.type,
    'insightd.pve.node': r.node,
  };
  if (r.tags && r.tags.length > 0) {
    labels['insightd.pve.tags'] = r.tags;
  }
  return labels;
}

/**
 * Run `pvesh get <path> --output-format json` and parse the result.
 * Throws if pvesh exits non-zero, the JSON is malformed, or the call times out.
 *
 * Reads `child_process.execFile` lazily (rather than destructuring at module
 * load) so tests can replace the export via mock.method without race
 * conditions around when the module's promisify-wrapped reference was bound.
 */
async function pvesh<T>(path: string): Promise<T> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const stdout: string = await new Promise((resolve, reject) => {
    execFile(
      PVESH_PATH,
      ['get', path, '--output-format', 'json'],
      { timeout: PVESH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => {
        // execFile with default options returns stdout as a string.
        if (err) reject(err);
        else resolve(out);
      },
    );
  });
  return JSON.parse(stdout) as T;
}
