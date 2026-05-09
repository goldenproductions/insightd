import type Database from 'better-sqlite3';

export type IdentityHint = {
  virt_type: 'qemu' | 'lxc' | 'bare';
  system_uuid: string | null;
  hostname: string;
  primary_mac: string | null;
};

export type IdentityMatch = {
  cluster_id: string | null;
  node: string;
  vmid: number;
  guest_type: 'qemu' | 'lxc';
};

type GuestRow = {
  cluster_id: string | null;
  node: string;
  vmid: number;
  guest_type: 'qemu' | 'lxc';
  guest_uuid: string | null;
  guest_primary_mac: string | null;
  container_name: string;
};

/**
 * Returns the latest snapshot row per (host_id, guest_vmid), joined to the
 * hosts table to retrieve the Proxmox cluster_id.
 *
 * The correlated-subquery on (host_id, guest_vmid) is safe here because the
 * candidate set is small (one row per live PVE guest) and the
 * idx_snapshots_host_name_time index covers the MAX(collected_at) scan.
 */
function latestGuestSnapshots(db: Database.Database): GuestRow[] {
  return db.prepare(`
    SELECT cluster_id, node, vmid, guest_type, guest_uuid, guest_primary_mac, container_name
      FROM (
        SELECT
          h.proxmox_cluster_id  AS cluster_id,
          cs.host_id            AS node,
          cs.guest_vmid         AS vmid,
          cs.guest_type,
          cs.guest_uuid,
          cs.guest_primary_mac,
          cs.container_name,
          ROW_NUMBER() OVER (PARTITION BY cs.host_id, cs.guest_vmid ORDER BY cs.collected_at DESC) AS rn
        FROM container_snapshots cs
        LEFT JOIN hosts h ON h.host_id = cs.host_id
        WHERE cs.guest_vmid IS NOT NULL
      )
     WHERE rn = 1
  `).all() as GuestRow[];
}

/**
 * Match an in-guest identity hint against the PVE inventory stored in the hub.
 *
 * Resolution strategy:
 *   qemu — match on SMBIOS UUID (case-insensitive). One match → resolved.
 *   lxc  — match on hostname (= displayName after the last '/') OR primary MAC.
 *           If multiple candidates share a hostname, prefer the one that ALSO
 *           matches the MAC (both-match tiebreaker). Still ambiguous → null.
 *   bare — not a VM, always null.
 *
 * Returns null when there is no confident single match.
 */
export function matchIdentityHint(
  db: Database.Database,
  _hostId: string,
  hint: IdentityHint,
): IdentityMatch | null {
  if (hint.virt_type === 'bare') return null;

  const guests = latestGuestSnapshots(db);

  if (hint.virt_type === 'qemu') {
    if (!hint.system_uuid) return null;
    const wanted = hint.system_uuid.toLowerCase();
    const matches = guests.filter(
      g => g.guest_type === 'qemu' && (g.guest_uuid ?? '').toLowerCase() === wanted,
    );
    if (matches.length !== 1) return null;
    const g = matches[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'qemu' };
  }

  // lxc: match by hostname (displayName = part after last '/') OR by MAC.
  const candidates = guests.filter(g => {
    if (g.guest_type !== 'lxc') return false;
    const displayName = (g.container_name.split('/').pop() ?? '').toLowerCase();
    const nameMatch = displayName === hint.hostname.toLowerCase();
    const macMatch =
      !!hint.primary_mac &&
      g.guest_primary_mac !== null &&
      g.guest_primary_mac.toLowerCase() === hint.primary_mac.toLowerCase();
    return nameMatch || macMatch;
  });

  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const g = candidates[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'lxc' };
  }

  // Multiple candidates — try the both-match tiebreaker.
  const both = candidates.filter(g => {
    const displayName = (g.container_name.split('/').pop() ?? '').toLowerCase();
    return (
      displayName === hint.hostname.toLowerCase() &&
      !!hint.primary_mac &&
      g.guest_primary_mac !== null &&
      g.guest_primary_mac.toLowerCase() === hint.primary_mac.toLowerCase()
    );
  });

  if (both.length === 1) {
    const g = both[0];
    return { cluster_id: g.cluster_id, node: g.node, vmid: g.vmid, guest_type: 'lxc' };
  }

  // Still ambiguous.
  return null;
}
