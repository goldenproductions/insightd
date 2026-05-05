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
