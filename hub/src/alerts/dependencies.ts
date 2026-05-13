import type Database from 'better-sqlite3';

type ScopeKey = 'host' | 'cluster' | 'container';

interface Dep {
  parent: string;
  scope: ScopeKey;
  children: string[];
}

const DEPS: Dep[] = [
  {
    parent: 'host_offline',
    scope: 'host',
    children: [
      'container_down', 'restart_loop',
      'high_cpu', 'high_memory',
      'container_memory_saturation', 'container_cpu_saturation',
      'container_unhealthy', 'image_pull_failure',
      'high_host_cpu', 'low_host_memory', 'high_load',
      'node_pressure', 'node_not_ready',
      'workload_unavailable', 'workload_degraded', 'workload_rollout_stuck',
      'pod_pending',
    ],
  },
  {
    parent: 'node_not_ready',
    scope: 'host',
    children: [
      'container_down', 'restart_loop', 'container_unhealthy',
      'image_pull_failure', 'pod_pending',
      'workload_unavailable', 'workload_degraded', 'workload_rollout_stuck',
    ],
  },
  {
    parent: 'pve_cluster_quorum_lost',
    scope: 'cluster',
    children: [
      'pve_zfs_unhealthy', 'pve_storage_saturation', 'pve_backup_overdue',
    ],
  },
  {
    parent: 'respawn_loop',
    scope: 'container',
    children: ['high_cpu', 'high_memory'],
  },
];

// Reverse index: child -> list of parents that suppress it
const PARENT_INDEX: Map<string, Dep[]> = (() => {
  const m = new Map<string, Dep[]>();
  for (const d of DEPS) {
    for (const c of d.children) {
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(d);
    }
  }
  return m;
})();

interface AlertLike { type: string; hostId: string; target: string }

interface ParentRow {
  id: number;
  alert_type: string;
  host_id: string;
  target: string;
}

function findActiveParent(db: Database.Database, alert: AlertLike): ParentRow | null {
  const parents = PARENT_INDEX.get(alert.type);
  if (!parents) return null;
  for (const dep of parents) {
    let row: ParentRow | undefined;
    if (dep.scope === 'host') {
      row = db.prepare(`
        SELECT id, alert_type, host_id, target FROM alert_state
        WHERE alert_type = ? AND host_id = ? AND resolved_at IS NULL
        LIMIT 1
      `).get(dep.parent, alert.hostId) as ParentRow | undefined;
    } else if (dep.scope === 'container') {
      row = db.prepare(`
        SELECT id, alert_type, host_id, target FROM alert_state
        WHERE alert_type = ? AND host_id = ? AND target = ? AND resolved_at IS NULL
        LIMIT 1
      `).get(dep.parent, alert.hostId, alert.target) as ParentRow | undefined;
    } else {
      // cluster
      row = db.prepare(`
        SELECT s.id, s.alert_type, s.host_id, s.target
        FROM alert_state s
        JOIN hosts hp ON hp.host_id = s.host_id
        JOIN hosts hc ON hc.host_id = ?
        WHERE s.alert_type = ?
          AND s.resolved_at IS NULL
          AND hp.proxmox_cluster_id IS NOT NULL
          AND hp.proxmox_cluster_id = hc.proxmox_cluster_id
        LIMIT 1
      `).get(alert.hostId, dep.parent) as ParentRow | undefined;
    }
    if (row) return row;
  }
  return null;
}

interface ParentLike { alert_type: string; host_id: string; target?: string }

function findActiveChildren(db: Database.Database, parent: ParentLike): Array<{ id: number; alert_type: string; host_id: string; target: string; resolved_at: string | null }> {
  const dep = DEPS.find(d => d.parent === parent.alert_type);
  if (!dep) return [];
  const placeholders = dep.children.map(() => '?').join(',');
  if (dep.scope === 'host') {
    return db.prepare(`
      SELECT id, alert_type, host_id, target, resolved_at FROM alert_state
      WHERE host_id = ? AND alert_type IN (${placeholders})
    `).all(parent.host_id, ...dep.children) as any;
  }
  if (dep.scope === 'container') {
    return db.prepare(`
      SELECT id, alert_type, host_id, target, resolved_at FROM alert_state
      WHERE host_id = ? AND target = ? AND alert_type IN (${placeholders})
    `).all(parent.host_id, parent.target ?? '', ...dep.children) as any;
  }
  // cluster
  return db.prepare(`
    SELECT s.id, s.alert_type, s.host_id, s.target, s.resolved_at FROM alert_state s
    JOIN hosts hp ON hp.host_id = s.host_id
    JOIN hosts hc ON hc.host_id = ?
    WHERE s.alert_type IN (${placeholders})
      AND hp.proxmox_cluster_id IS NOT NULL
      AND hp.proxmox_cluster_id = hc.proxmox_cluster_id
  `).all(parent.host_id, ...dep.children) as any;
}

module.exports = { DEPS, findActiveParent, findActiveChildren };
