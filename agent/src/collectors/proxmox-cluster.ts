import logger = require('../../../shared/utils/logger');
import { pvesh } from '../runtime/pvesh';

/**
 * Cluster-scoped collectors for Proxmox VE: storage pools (per-node),
 * ZFS pool health (per-node), and cluster quorum (cluster-scoped).
 *
 * No leader election in v1 — every PVE node publishes everything and the
 * hub deduplicates by primary key:
 *   - pve_storage_snapshots is host-scoped naturally (PK includes host_id)
 *   - pve_zfs_pools is host-scoped naturally (PK = host_id, pool_name)
 *   - pve_cluster_status PK = cluster_name; every node writes the same row,
 *     last cycle wins. Fine because they all see the same corosync state.
 *
 * Each collector returns plain typed data; the scheduler is responsible for
 * publishing. Errors bubble out — the scheduler wraps every call in safeCollect.
 */

export interface PveStoragePool {
  storageName: string;
  storageType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  active: boolean;
  shared: boolean;
}

export interface PveZfsPool {
  poolName: string;
  health: string;
  sizeBytes: number | null;
  allocBytes: number | null;
  fragmentation: number | null;
  dedupRatio: number | null;
  lastScrubAt: string | null;
}

export interface PveClusterStatus {
  clusterName: string;
  quorate: boolean;
  totalNodes: number;
  onlineNodes: number;
}

export interface PveGuestSnapshotInfo {
  guestVmid: number;
  /** Number of named snapshots (excludes the synthetic "current" entry). */
  snapshotCount: number;
  /** ISO timestamp of the newest snapshot, or null if none. */
  newestAt: string | null;
  /** ISO timestamp of the oldest snapshot, or null if none. */
  oldestAt: string | null;
}

export interface PveGuestRef {
  vmid: number;
  type: 'qemu' | 'lxc';
}

export interface PveGuestBackupInfo {
  guestVmid: number;
  /** ISO timestamp of the most recent successful vzdump, or null if never. */
  lastBackupAt: string | null;
  /** 'OK' for last successful run, 'FAILED' for last attempt failed, 'NEVER' if no backup record exists. */
  lastStatus: 'OK' | 'FAILED' | 'NEVER';
  /** vzdump destination storage (best-effort, may be null). */
  storageTarget: string | null;
}

interface PveStorageRow {
  storage: string;
  type: string;
  total?: number;
  used?: number;
  active?: number;
  shared?: number;
  enabled?: number;
}

interface PveZfsRow {
  name: string;
  health: string;
  size?: number;
  alloc?: number;
  free?: number;
  frag?: number;
  dedup?: number;
}

interface PveClusterStatusRow {
  type: string;
  name?: string;
  quorate?: number;
  local?: number;
  online?: number;
  nodes?: number;
}

interface PveSnapshotRow {
  name: string;
  parent?: string;
  /** Unix epoch seconds. PVE's special "current" entry has no snaptime. */
  snaptime?: number;
}

interface PveTaskRow {
  upid: string;
  starttime?: number;
  endtime?: number;
  /** 'OK' on success, an error string on failure. */
  status?: string;
  /** Task type — 'vzdump', 'qmstart', etc. */
  type?: string;
  /** For vzdump tasks, this is the vmid as a string ("103"). */
  id?: string;
  user?: string;
  node?: string;
}

interface PveBackupNotBackedUpRow {
  vmid: number;
  type: string;
  name?: string;
}

/**
 * Per-storage-pool usage on this node. Used to drive the
 * `pve_storage_saturation` alert (warns when used/total exceeds threshold)
 * and the Storage Pools card in the host detail.
 */
export async function collectStoragePools(nodeName: string): Promise<PveStoragePool[]> {
  const rows = await pvesh<PveStorageRow[]>(`/nodes/${encodeURIComponent(nodeName)}/storage`);
  return rows.map(r => ({
    storageName: r.storage,
    storageType: r.type,
    totalBytes: typeof r.total === 'number' && r.total > 0 ? r.total : null,
    usedBytes: typeof r.used === 'number' ? r.used : null,
    // PVE's `active` field can be 0 for storages PVE knows about but isn't
    // currently mounting (offline NFS server, missing disk). Surfacing as a
    // boolean lets the saturation check skip them rather than alert on 0/0.
    active: r.active === 1,
    shared: r.shared === 1,
  }));
}

/**
 * Per-ZFS-pool health and usage. Drives the `pve_zfs_unhealthy` alert and
 * the ZFS Pools card. PVE's /disks/zfs endpoint doesn't expose last-scrub —
 * we'd need a per-pool detail call to get scan history. Left null for v1.
 */
export async function collectZfsPools(nodeName: string): Promise<PveZfsPool[]> {
  let rows: PveZfsRow[];
  try {
    rows = await pvesh<PveZfsRow[]>(`/nodes/${encodeURIComponent(nodeName)}/disks/zfs`);
  } catch (err) {
    // Hosts without ZFS return an error from `zpool list`; treat as no pools
    // rather than failing the whole collection cycle.
    logger.info('proxmox-cluster', `No ZFS pools on ${nodeName} (${(err as Error).message})`);
    return [];
  }
  return rows.map(r => ({
    poolName: r.name,
    health: r.health,
    sizeBytes: typeof r.size === 'number' && r.size > 0 ? r.size : null,
    allocBytes: typeof r.alloc === 'number' ? r.alloc : null,
    fragmentation: typeof r.frag === 'number' ? r.frag : null,
    dedupRatio: typeof r.dedup === 'number' ? r.dedup : null,
    lastScrubAt: null,
  }));
}

/**
 * Cluster quorum + node count. Returns null on a single-node "cluster of
 * one" install (no /cluster/status row of type='cluster'); the hub treats
 * null-quorum as "not applicable" and skips the alert.
 */
export async function collectClusterStatus(): Promise<PveClusterStatus | null> {
  const rows = await pvesh<PveClusterStatusRow[]>('/cluster/status');
  // Per the docs: type='cluster' row carries quorate + total node count;
  // type='node' rows carry per-node online status. Single-node installs may
  // omit the cluster row entirely.
  const cluster = rows.find(r => r.type === 'cluster');
  const nodes = rows.filter(r => r.type === 'node');

  if (!cluster) {
    // Standalone PVE host — there's no cluster to lose quorum for.
    return null;
  }

  return {
    clusterName: cluster.name ?? 'pve',
    quorate: cluster.quorate === 1,
    totalNodes: typeof cluster.nodes === 'number' ? cluster.nodes : nodes.length,
    onlineNodes: nodes.filter(n => n.online === 1).length,
  };
}

/**
 * Per-guest snapshot inventory — one pvesh call per guest. Skips the
 * synthetic "current" entry (PVE's representation of the running state, not
 * a real snapshot). For 50 guests this is ~50 pvesh calls per cycle; if
 * that becomes a hotspot, fold into the lower-frequency periodic mine cron.
 *
 * Failures are isolated per-guest (e.g. config moved between nodes mid-call,
 * VM destroyed during enumeration) so one bad VMID doesn't sink the batch.
 */
export async function collectGuestSnapshots(
  nodeName: string,
  guests: PveGuestRef[],
): Promise<PveGuestSnapshotInfo[]> {
  const out: PveGuestSnapshotInfo[] = [];
  for (const g of guests) {
    try {
      const rows = await pvesh<PveSnapshotRow[]>(
        `/nodes/${encodeURIComponent(nodeName)}/${g.type}/${g.vmid}/snapshot`,
      );
      const real = rows.filter(r => r.name !== 'current' && typeof r.snaptime === 'number');
      if (real.length === 0) {
        out.push({ guestVmid: g.vmid, snapshotCount: 0, newestAt: null, oldestAt: null });
        continue;
      }
      const times = real.map(r => r.snaptime as number).sort((a, b) => a - b);
      out.push({
        guestVmid: g.vmid,
        snapshotCount: real.length,
        oldestAt: new Date(times[0] * 1000).toISOString(),
        newestAt: new Date(times[times.length - 1] * 1000).toISOString(),
      });
    } catch (err) {
      logger.info('proxmox-cluster', `Snapshot enum for ${g.type}/${g.vmid} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Cluster-wide backup history. One pvesh call to /cluster/tasks gives the
 * recent task log (vzdump runs included); /cluster/backup-info/not-backed-up
 * fills in guests with no successful backup ever.
 *
 * Returns one row per VMID actually present on this node — skips backup
 * tasks for guests that no longer exist or live on a different node.
 */
export async function collectGuestBackups(
  guests: PveGuestRef[],
): Promise<PveGuestBackupInfo[]> {
  const presentVmids = new Set(guests.map(g => g.vmid));
  if (presentVmids.size === 0) return [];

  // Most recent task per VMID. PVE's /cluster/tasks default returns ~50
  // tasks; bump limit so a busy cluster's vzdump history isn't crowded out
  // by qmstart/qmstop noise.
  let tasks: PveTaskRow[] = [];
  try {
    tasks = await pvesh<PveTaskRow[]>('/cluster/tasks');
  } catch (err) {
    logger.info('proxmox-cluster', `cluster/tasks fetch failed: ${(err as Error).message}`);
  }

  // newest-first per VMID — first task we see for a vmid wins.
  const latestByVmid = new Map<number, PveTaskRow>();
  const sorted = tasks
    .filter(t => t.type === 'vzdump' && typeof t.endtime === 'number')
    .sort((a, b) => (b.endtime ?? 0) - (a.endtime ?? 0));
  for (const t of sorted) {
    const vmid = parseVzdumpVmid(t);
    if (vmid == null || !presentVmids.has(vmid)) continue;
    if (!latestByVmid.has(vmid)) latestByVmid.set(vmid, t);
  }

  // Anything still missing → check the not-backed-up endpoint so we can
  // distinguish "never backed up" from "no recent task in the visible window".
  const neverBackedUp = new Set<number>();
  if ([...presentVmids].some(v => !latestByVmid.has(v))) {
    try {
      const rows = await pvesh<PveBackupNotBackedUpRow[]>('/cluster/backup-info/not-backed-up');
      for (const r of rows) neverBackedUp.add(r.vmid);
    } catch (err) {
      logger.info('proxmox-cluster', `not-backed-up fetch failed: ${(err as Error).message}`);
    }
  }

  const out: PveGuestBackupInfo[] = [];
  for (const vmid of presentVmids) {
    const t = latestByVmid.get(vmid);
    if (t) {
      out.push({
        guestVmid: vmid,
        lastBackupAt: t.endtime ? new Date(t.endtime * 1000).toISOString() : null,
        lastStatus: t.status === 'OK' ? 'OK' : 'FAILED',
        storageTarget: null,  // not exposed in /cluster/tasks; would need vzdump.conf parse
      });
    } else if (neverBackedUp.has(vmid)) {
      out.push({ guestVmid: vmid, lastBackupAt: null, lastStatus: 'NEVER', storageTarget: null });
    }
    // else: guest not in either list. Could be a fresh guest the API hasn't
    // catalogued yet; skip rather than emit a false NEVER.
  }
  return out;
}

/**
 * vzdump task `id` field is the bare VMID as a string ("103"). Some PVE
 * versions wrap it in the type prefix ("qemu/103" or "lxc/103") so accept
 * both. Returns null on anything we don't recognize.
 */
function parseVzdumpVmid(t: PveTaskRow): number | null {
  if (!t.id) return null;
  const stripped = t.id.includes('/') ? t.id.split('/').pop()! : t.id;
  const n = Number(stripped);
  return Number.isInteger(n) && n > 0 ? n : null;
}
