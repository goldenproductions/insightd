import os = require('os');
import logger = require('../../../shared/utils/logger');
import { pveApi, pveAction, isRestMode, configurePveTransport, type PveApiConfig } from './pveApi';
import type {
  ContainerRuntime, ContainerInfo, ContainerWithResources,
  LogEntry, LogOptions, ContainerAction, ActionResult, ImageUpdate,
} from './types';
import { LogsUnavailableError } from './types';

const VALID_ACTIONS: ContainerAction[] = ['start', 'stop', 'restart', 'remove'];
const ACTION_TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 10_000;
const LOG_MAX_BUFFER = 8 * 1024 * 1024;

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
 * Capabilities by PR:
 * - PR1: list + resource collection
 * - PR2: cluster-scoped collectors (storage / ZFS / quorum)
 * - PR3: per-guest snapshot + backup collectors
 * - PR4: pct/qm actions, LXC log fetch, identity bridge
 */
export class ProxmoxRuntime implements ContainerRuntime {
  readonly name = 'proxmox' as const;
  readonly supportsActions: boolean;
  readonly supportsUpdateChecks = false;  // not meaningful for VMs/LXC

  /** PVE node name as PVE itself sees it.
   *  - local-shell mode: resolved from `/cluster/status` `local=1` row.
   *  - REST mode: provided by INSIGHTD_PVE_NODE (no `local` notion remotely).
   *  Public so the scheduler can pass it into the cluster-scoped collectors
   *  in `agent/src/collectors/proxmox-cluster.ts`. */
  nodeName: string = os.hostname();

  private allowActions: boolean;
  private apiConfig?: PveApiConfig;
  /** Operator-declared node name from INSIGHTD_PVE_NODE, used only in REST mode. */
  private configuredNodeName?: string;

  /** In-cycle cache so listContainers and collectResources share one pvesh call. */
  private resourceCache = new Map<string, PveResource>();

  constructor(options: {
    allowActions?: boolean;
    api?: PveApiConfig;
    nodeName?: string;
  } = {}) {
    this.allowActions = options.allowActions === true;
    this.apiConfig = options.api;
    this.configuredNodeName = options.nodeName;
    // supportsActions advertises capability, not authorization — true even
    // when allowActions=false so the UI doesn't claim "actions unsupported"
    // when the operator just hasn't enabled them. The performAction() guard
    // returns the actionable error message in that case.
    this.supportsActions = true;

    // Wire the transport before anything else can call pveApi/pveAction.
    // configurePveTransport with empty config selects local-shell.
    configurePveTransport(this.apiConfig ?? {});
  }

  async init(): Promise<void> {
    // Confirm the chosen transport works. A clear error here beats an obscure
    // ENOENT (local-shell missing pvesh) or 401 (REST bad token) on every
    // collection cycle.
    try {
      const status = await pveApi<PveClusterStatusRow[]>('/cluster/status');
      if (isRestMode()) {
        // No `local` notion when we're remote — the operator told us which
        // node we cover. Validate it actually exists in the cluster so a
        // typo surfaces here, not as silently-empty listContainers later.
        if (!this.configuredNodeName) {
          throw new Error('REST mode requires INSIGHTD_PVE_NODE to declare which node this agent covers');
        }
        const match = status.find(r => r.type === 'node' && r.name === this.configuredNodeName);
        if (!match) {
          const known = status.filter(r => r.type === 'node').map(r => r.name).join(', ');
          throw new Error(`INSIGHTD_PVE_NODE="${this.configuredNodeName}" not found in cluster. Known nodes: ${known || '(none)'}`);
        }
        this.nodeName = this.configuredNodeName;
        logger.info('proxmox', `Connected via REST API — node: ${this.nodeName}`);
      } else {
        const local = status.find(r => r.type === 'node' && r.local === 1);
        if (local?.name) this.nodeName = local.name;
        logger.info('proxmox', `Connected via pvesh — local node: ${this.nodeName}`);
      }
    } catch (err) {
      throw new Error(`ProxmoxRuntime init failed: ${(err as Error).message}`);
    }
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const resources = await pveApi<PveResource[]>('/cluster/resources');
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

  /**
   * Best-effort log fetch for PVE guests.
   *
   * - LXC: try `journalctl --machine=<vmid>` first (works for unprivileged
   *   LXCs with reachable systemd-journald). Falls back to
   *   `pct exec <vmid> -- journalctl -n <lines>` which works for any LXC
   *   regardless of journald reachability but forks into the container's
   *   namespace (heavier).
   * - QEMU: no host-side log path. Throws an error the UI catches to render
   *   an "install in-guest agent" empty state.
   *
   * containerId is the PVE id field from listContainers (`lxc/200` or
   * `qemu/103`) so we don't need to re-look-up the type.
   */
  async fetchLogs(containerId: string, options: LogOptions): Promise<LogEntry[]> {
    const parsed = parseGuestId(containerId);
    if (!parsed) throw new Error(`Unrecognised PVE guest id: "${containerId}"`);
    const lines = Math.max(1, Math.min(10_000, options.lines ?? 100));

    if (isRestMode()) {
      // PVE's `/exec` REST endpoint is async/streaming and only useful with
      // VM.Console on the token — too much surface for a feature that's
      // already best-effort on LXC and unavailable on QEMU. Throws
      // LogsUnavailableError so the MQTT dispatcher and UI treat this as a
      // documented empty state rather than a fetch failure.
      throw new LogsUnavailableError(
        'Logs are not available when insightd reads PVE via REST API. ' +
        'Install insightd-agent inside the guest to surface its logs here.'
      );
    }

    if (parsed.type === 'qemu') {
      throw new LogsUnavailableError(
        'Logs are not available for QEMU guests from the hypervisor. ' +
        'Install insightd-agent inside the VM to surface its logs here.'
      );
    }

    // LXC path 1 — journalctl --machine. Works for unprivileged LXCs whose
    // systemd-journald is reachable from the host. Fast (no namespace fork).
    try {
      const out = await execStdout('journalctl', [
        `--machine=${parsed.vmid}`, '-n', String(lines),
        '--no-pager', '--output=short-iso',
      ], LOG_TIMEOUT_MS);
      const entries = parseJournalctlPlain(out);
      if (entries.length > 0) return entries;
      // Empty output usually means "nothing logged yet" rather than failure
      // — surface as empty array. Continue to fallback only on actual error.
      return entries;
    } catch (err) {
      logger.info('proxmox', `journalctl --machine=${parsed.vmid} failed (${(err as Error).message}); falling back to pct exec`);
    }

    // LXC path 2 — pct exec. Works for any LXC but slower; the guest needs
    // journalctl on its $PATH (true for any systemd LXC).
    try {
      const out = await execStdout('pct', [
        'exec', String(parsed.vmid), '--',
        'journalctl', '-n', String(lines), '--no-pager', '--output=short-iso',
      ], LOG_TIMEOUT_MS);
      return parseJournalctlPlain(out);
    } catch (err) {
      logger.warn('proxmox', `pct exec journalctl on ${parsed.vmid} failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Start / stop / restart / remove a PVE guest via pct or qm.
   *
   * - start: `<tool> start <vmid>` — async on PVE side; returns immediately.
   * - stop: `<tool> shutdown <vmid>` — graceful (ACPI for QEMU). Falls through
   *   to nothing-happens if the guest ignores ACPI; users can wait or use a
   *   second action call.
   * - restart: `<tool> reboot <vmid>` — graceful. QEMU requires the guest
   *   agent or an ACPI-aware OS; documented in proxmox-setup.md.
   * - remove: `<tool> destroy <vmid>` — refuses to remove a running guest;
   *   we surface PVE's own error in that case.
   *
   * containerName arrives from the hub as `<node>/<vmid>` (matches the
   * format ProxmoxRuntime stamps on listContainers). We re-query
   * /cluster/resources every call rather than trust the resourceCache from
   * listContainers — actions can fire between cycles and the cache may be
   * stale (guest migrated away, vmid recreated).
   */
  async performAction(containerName: string, action: ContainerAction): Promise<ActionResult> {
    if (!this.allowActions) {
      throw new Error('Proxmox actions are disabled. Set INSIGHTD_ALLOW_ACTIONS=true to enable.');
    }
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(`Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
    }

    const slash = containerName.indexOf('/');
    if (slash < 0) {
      throw new Error(`Unrecognised PVE container name "${containerName}" — expected "<node>/<vmid>"`);
    }
    const targetNode = containerName.slice(0, slash);
    const vmidPart = containerName.slice(slash + 1);
    const vmid = Number(vmidPart);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      throw new Error(`Unrecognised PVE container name "${containerName}" — non-numeric vmid`);
    }
    if (targetNode !== this.nodeName) {
      throw new Error(`Guest ${vmid} lives on node "${targetNode}", not this agent's node "${this.nodeName}"`);
    }

    // Look up the type fresh — caches go stale, action requests don't.
    const resources = await pveApi<PveResource[]>('/cluster/resources');
    const guest = resources.find(r => r.vmid === vmid && r.node === targetNode && (r.type === 'lxc' || r.type === 'qemu'));
    if (!guest) {
      throw new Error(`PVE guest vmid=${vmid} not found on node "${targetNode}"`);
    }

    const verb = pveActionVerb(action);
    const past = action === 'stop' ? 'shutdown initiated'
      : action === 'restart' ? 'reboot initiated'
      : action === 'remove' ? 'destroyed'
      : 'started';

    if (isRestMode()) {
      // REST mode: fire-and-forget; surface the UPID in the success message
      // so operators can poll PVE's task log for completion if they want to.
      // remove → DELETE /nodes/{node}/{type}/{vmid}; everything else POST
      // /nodes/{node}/{type}/{vmid}/status/{verb}.
      const basePath = `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${vmid}`;
      logger.info('actions', `Performing ${action} on ${guest.type}/${vmid} via REST ${verb}`);
      try {
        const upid = action === 'remove'
          ? await pveAction('DELETE', basePath)
          : await pveAction('POST', `${basePath}/status/${verb}`);
        const upidPart = typeof upid === 'string' && upid.length > 0
          ? ` — UPID:${upid}`
          : '';
        return {
          status: 'success',
          message: `Proxmox guest "${containerName}" ${past}${upidPart}`,
        };
      } catch (err) {
        // REST errors already include the PVE error envelope detail (see
        // pveApi.ts:describeError) — pass through unchanged.
        throw new Error(`PVE ${verb} on ${guest.type}/${vmid} failed: ${(err as Error).message}`);
      }
    }

    // Local-shell mode — same shape as before PR5.
    const tool = guest.type === 'qemu' ? 'qm' : 'pct';
    logger.info('actions', `Performing ${action} on ${guest.type}/${vmid} via ${tool} ${verb}`);
    try {
      const out = await execStdout(tool, [verb, String(vmid)], ACTION_TIMEOUT_MS);
      const trailer = out.trim() ? ` — ${out.trim()}` : '';
      return {
        status: 'success',
        message: `Proxmox guest "${containerName}" ${past}${trailer}`,
      };
    } catch (err) {
      throw new Error(`${tool} ${verb} ${vmid} failed: ${(err as Error).message}`);
    }
  }

  async checkImageUpdates(): Promise<ImageUpdate[]> {
    // No "image" concept for VMs/LXC. Returning an empty array is the contract.
    return [];
  }
}

function parseGuestId(id: string): { type: 'qemu' | 'lxc'; vmid: number } | null {
  const slash = id.indexOf('/');
  if (slash < 0) return null;
  const type = id.slice(0, slash);
  const vmid = Number(id.slice(slash + 1));
  if ((type !== 'qemu' && type !== 'lxc') || !Number.isInteger(vmid) || vmid <= 0) return null;
  return { type, vmid };
}

function pveActionVerb(action: ContainerAction): string {
  switch (action) {
    case 'start':   return 'start';
    case 'stop':    return 'shutdown'; // graceful; matches Docker stop({t:10})
    case 'restart': return 'reboot';
    case 'remove':  return 'destroy';  // PVE refuses on a running guest
  }
}

/**
 * Parse `journalctl --output=short-iso` output. Each line looks like:
 *   2026-05-05T17:42:13+0000 hostname process[pid]: message
 * We split off the leading timestamp and treat the rest as the message body.
 * Anything that doesn't match falls through with timestamp=null.
 */
function parseJournalctlPlain(stdout: string): LogEntry[] {
  const out: LogEntry[] = [];
  const re = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{4})\s+(.*)$/;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const m = re.exec(raw);
    if (m) {
      out.push({ stream: 'stdout', timestamp: m[1], message: m[2] });
    } else {
      out.push({ stream: 'stdout', timestamp: null, message: raw });
    }
  }
  return out;
}

/**
 * Run a child process and capture stdout. Reads `child_process.execFile`
 * lazily so tests can swap it via mock.method (same pattern as pvesh.ts).
 */
async function execStdout(file: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = require('child_process') as typeof import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: LOG_MAX_BUFFER }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
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

