import type Database from 'better-sqlite3';

/**
 * Proxmox VE insight checks. Sibling to the right-sizing detector — runs
 * once per insights cycle and writes findings into the shared `insights`
 * table under category 'proxmox'.
 *
 * NOT part of the per-container diagnosis framework (`hub/src/insights/
 * diagnosis/`) because that framework is container-symptom-scoped: it asks
 * "why is THIS container unhealthy?" with logs + baselines + correlations.
 * The Proxmox checks are different — periodic, host- or guest-scoped, and
 * dispatched off PVE-specific tables that the unified diagnoser doesn't
 * know about. Keeping them in a separate module avoids polluting the
 * diagnosis framework's entity model.
 *
 * Each function returns the count of insights inserted so generateInsights
 * can roll them up into the cycle's total.
 */

interface InsightInsert {
  run(
    entityType: string,
    entityId: string,
    category: string,
    severity: 'critical' | 'warning' | 'info',
    title: string,
    message: string,
    metric: string | null,
    currentValue: number | null,
    baselineValue: number | null,
    evidence: string | null,
  ): { changes: number };
}

/**
 * Write all PVE-specific insights for the current cycle. Caller is
 * generateInsights, which has already DELETE FROM insights'd at the top so
 * we just INSERT.
 */
export function generateProxmoxInsights(db: Database.Database, insert: InsightInsert): number {
  let count = 0;
  count += hostQuorumLostInsight(db, insert);
  count += hostZfsDegradedInsights(db, insert);
  // The host-scope check runs first and returns the set of host_ids that
  // got a "no backups configured at all" insight. The per-guest check then
  // skips those hosts so a 14-guest homelab gets one warning, not 14.
  const noBackupHosts = hostNoBackupsConfiguredInsights(db, insert);
  count += noBackupHosts.size;
  count += guestNoBackupInsights(db, insert, noBackupHosts);
  count += guestSnapshotAccumulationInsights(db, insert);
  return count;
}

interface ZfsRow { host_id: string; pool_name: string; health: string; fragmentation: number | null; last_scrub_at: string | null; }
interface QuorumRow { cluster_name: string; total_nodes: number; online_nodes: number; }
interface BackupRow { host_id: string; guest_vmid: number; last_backup_at: string | null; last_status: string; guest_name: string | null; guest_type: string | null; }
interface SnapshotRow { host_id: string; guest_vmid: number; snapshot_count: number; oldest_at: string | null; newest_at: string | null; guest_name: string | null; guest_type: string | null; }

/**
 * One critical insight per cluster that's lost quorum. Mirrors the alert
 * but adds the suggested-action link to `pvecm status` so operators have a
 * starting command. entity_type='host', entity_id=cluster_name (cluster-
 * scoped, no individual host responsible).
 */
function hostQuorumLostInsight(db: Database.Database, insert: InsightInsert): number {
  const rows = db.prepare(
    'SELECT cluster_name, total_nodes, online_nodes FROM pve_cluster_status WHERE quorate = 0'
  ).all() as QuorumRow[];
  for (const r of rows) {
    insert.run(
      'host', r.cluster_name, 'proxmox', 'critical',
      `Cluster "${r.cluster_name}" has lost quorum`,
      `Only ${r.online_nodes}/${r.total_nodes} nodes are online. VMs/LXC cannot be started or migrated until quorum is restored. Run \`pvecm status\` on a surviving node to inspect the corosync ring.`,
      'online_nodes', r.online_nodes, r.total_nodes, null,
    );
  }
  return rows.length;
}

/**
 * One warning insight per non-ONLINE ZFS pool. Severity scales with the
 * health state — FAULTED/UNAVAIL surface as critical, DEGRADED/OFFLINE as
 * warning. Suggested action: `zpool status -v <pool>` for the operator.
 */
function hostZfsDegradedInsights(db: Database.Database, insert: InsightInsert): number {
  const rows = db.prepare(
    `SELECT host_id, pool_name, health, fragmentation, last_scrub_at
     FROM pve_zfs_pools WHERE health != 'ONLINE'`
  ).all() as ZfsRow[];
  for (const r of rows) {
    const sev: 'critical' | 'warning' = (r.health === 'FAULTED' || r.health === 'UNAVAIL') ? 'critical' : 'warning';
    const fragNote = r.fragmentation != null ? ` Fragmentation ${r.fragmentation}%.` : '';
    const scrubNote = r.last_scrub_at ? ` Last scrub: ${r.last_scrub_at}.` : ' No scrub recorded.';
    insert.run(
      'host', r.host_id, 'proxmox', sev,
      `ZFS pool "${r.pool_name}" is ${r.health}`,
      `Pool "${r.pool_name}" on ${r.host_id} is in ${r.health} state.${fragNote}${scrubNote} Run \`zpool status -v ${r.pool_name}\` to identify the failing vdev.`,
      'health', null, null, null,
    );
  }
  return rows.length;
}

/**
 * One host-scoped insight per PVE host with no automated backups at all
 * (every tracked guest reports last_status='NEVER'). Replaces what used to
 * be an N-row firestorm of per-guest "never backed up" insights *and* a
 * matching N-row alert blast — when the entire host is unbackuped the
 * actionable answer is the same for every guest ("set up vzdump"), so
 * a single warning at host scope is the right granularity.
 *
 * Returns the set of host_ids covered so the per-guest check can skip
 * them and avoid duplication.
 */
function hostNoBackupsConfiguredInsights(db: Database.Database, insert: InsightInsert): Set<string> {
  const rows = db.prepare(`
    SELECT host_id,
           COUNT(*) AS total,
           SUM(CASE WHEN last_status = 'NEVER' THEN 1 ELSE 0 END) AS never_count,
           SUM(CASE WHEN last_status = 'OK' THEN 1 ELSE 0 END) AS ok_count
    FROM pve_guest_backups
    GROUP BY host_id
    HAVING ok_count = 0 AND never_count > 0
  `).all() as Array<{ host_id: string; total: number; never_count: number; ok_count: number }>;

  const covered = new Set<string>();
  for (const r of rows) {
    insert.run(
      'host', r.host_id, 'proxmox', 'warning',
      `Proxmox host "${r.host_id}" has no automated backups configured`,
      `${r.never_count} guest${r.never_count === 1 ? '' : 's'} would be unrecoverable on disk loss. ` +
      `Configure vzdump under Datacenter → Backup.`,
      'guests_without_backup', r.never_count, null, null,
    );
    covered.add(r.host_id);
  }
  return covered;
}

/**
 * Per-guest "never backed up" insight for the *mixed* case — host has
 * some guests on a backup schedule but a few are missing. That's a
 * forgot-this-one signal, distinct from the host-scope "no backups at
 * all" case (which `hostNoBackupsConfiguredInsights` covers and passes
 * down via `skipHosts`). Severity tracks recovery cost: warning for QEMU
 * full VMs, info for LXC.
 */
function guestNoBackupInsights(db: Database.Database, insert: InsightInsert, skipHosts: Set<string>): number {
  const rows = db.prepare(`
    SELECT b.host_id, b.guest_vmid, b.last_backup_at, b.last_status,
           cs.container_name AS guest_name,
           cs.guest_type
    FROM pve_guest_backups b
    LEFT JOIN (
      SELECT cs1.host_id, cs1.guest_vmid, cs1.container_name, cs1.guest_type
      FROM container_snapshots cs1
      INNER JOIN (
        SELECT host_id, guest_vmid, MAX(collected_at) AS max_at
        FROM container_snapshots WHERE guest_vmid IS NOT NULL
        GROUP BY host_id, guest_vmid
      ) latest ON cs1.host_id = latest.host_id
              AND cs1.guest_vmid = latest.guest_vmid
              AND cs1.collected_at = latest.max_at
    ) cs ON cs.host_id = b.host_id AND cs.guest_vmid = b.guest_vmid
    WHERE b.last_status = 'NEVER'
  `).all() as BackupRow[];

  let inserted = 0;
  for (const r of rows) {
    if (skipHosts.has(r.host_id)) continue;
    const name = r.guest_name ?? `${r.host_id}/${r.guest_vmid}`;
    const sev: 'warning' | 'info' = r.guest_type === 'qemu' ? 'warning' : 'info';
    const recovery = r.guest_type === 'qemu'
      ? 'A full VM disk image is non-trivial to rebuild from scratch — schedule it under Datacenter → Backup.'
      : 'LXC containers are cheap to rebuild but having a backup makes recovery instant.';
    insert.run(
      'container', `${r.host_id}/${name}`, 'proxmox', sev,
      `Guest "${name}" has never been backed up`,
      `${recovery}`,
      'backup_age_days', null, null, null,
    );
    inserted++;
  }
  return inserted;
}

/**
 * Snapshot accumulation insight — fires when a guest has more than 8
 * snapshots. Severity is info (not actionable until performance is impacted)
 * but the message names the threshold so operators know why it surfaced.
 *
 * 8 was picked because (a) it's a round-ish small number, (b) Proxmox docs
 * caution about snapshot-count COW overhead on QEMU starting around there,
 * and (c) a manual user with three days of testing typically has 1-3 snapshots.
 */
function guestSnapshotAccumulationInsights(db: Database.Database, insert: InsightInsert): number {
  const SNAPSHOT_WARN = 8;
  const rows = db.prepare(`
    SELECT s.host_id, s.guest_vmid, s.snapshot_count, s.oldest_at, s.newest_at,
           cs.container_name AS guest_name, cs.guest_type
    FROM pve_guest_snapshots s
    LEFT JOIN (
      SELECT cs1.host_id, cs1.guest_vmid, cs1.container_name, cs1.guest_type
      FROM container_snapshots cs1
      INNER JOIN (
        SELECT host_id, guest_vmid, MAX(collected_at) AS max_at
        FROM container_snapshots WHERE guest_vmid IS NOT NULL
        GROUP BY host_id, guest_vmid
      ) latest ON cs1.host_id = latest.host_id
              AND cs1.guest_vmid = latest.guest_vmid
              AND cs1.collected_at = latest.max_at
    ) cs ON cs.host_id = s.host_id AND cs.guest_vmid = s.guest_vmid
    WHERE s.snapshot_count > ?
  `).all(SNAPSHOT_WARN) as SnapshotRow[];

  for (const r of rows) {
    const name = r.guest_name ?? `${r.host_id}/${r.guest_vmid}`;
    const oldestNote = r.oldest_at ? ` Oldest snapshot dates from ${r.oldest_at}.` : '';
    const cowNote = r.guest_type === 'qemu'
      ? 'QEMU snapshots use copy-on-write; long chains slow disk writes and lengthen rollback times.'
      : 'Old LXC snapshots reserve subvolume space without serving an obvious purpose.';
    insert.run(
      'container', `${r.host_id}/${name}`, 'proxmox', 'info',
      `Guest "${name}" has ${r.snapshot_count} snapshots`,
      `${cowNote}${oldestNote} Consider pruning unused snapshots from Datacenter → ${r.host_id} → ${name} → Snapshots.`,
      'snapshot_count', r.snapshot_count, SNAPSHOT_WARN, null,
    );
  }
  return rows.length;
}

module.exports = { generateProxmoxInsights };
