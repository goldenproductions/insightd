/**
 * Database queries for service groups.
 */

import type Database from 'better-sqlite3';

interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  source: string;
  member_count: number;
  running_count: number;
  total_cpu: number | null;
  total_memory: number | null;
  created_at: string;
  updated_at: string;
}

interface GroupBasicRow {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

interface GroupMemberRow {
  host_id: string;
  container_name: string;
  source: string;
  container_id: string | null;
  status: string | null;
  cpu_percent: number | null;
  memory_mb: number | null;
  restart_count: number | null;
  health_status: string | null;
  collected_at: string | null;
}

interface LabelsRow {
  labels: string | null;
}

interface GroupIdRow {
  id: number;
}

interface ContainerData {
  name: string;
  labels?: string | Record<string, string> | null;
  [key: string]: any;
}

interface GroupCreateData {
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  source?: string;
}

interface GroupUpdateData {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}

function getGroups(db: Database.Database, showInternal: boolean = false): GroupRow[] {
  // The old version used `ROW_NUMBER() OVER (PARTITION BY ...)` with no WHERE
  // clause on container_snapshots, which forces a full scan + window sort of
  // every row in that table (82k+ in prod). On a 100 MB DB that translated
  // to ~4 seconds per call — and the internal-filter loop below called it
  // again per group. The rewrite uses an index-friendly MAX() join restricted
  // to the last day of snapshots (more than enough for "latest per container"
  // while still hitting idx_snapshots_host_name_time).
  const groups = db.prepare(`
    WITH latest AS (
      SELECT cs.host_id, cs.container_name, cs.status, cs.cpu_percent,
             cs.memory_mb, cs.labels
      FROM container_snapshots cs
      INNER JOIN (
        SELECT host_id, container_name, MAX(collected_at) AS max_at
        FROM container_snapshots
        WHERE collected_at >= datetime('now', '-1 day')
        GROUP BY host_id, container_name
      ) m ON m.host_id = cs.host_id
         AND m.container_name = cs.container_name
         AND m.max_at = cs.collected_at
    )
    SELECT sg.*,
      COUNT(sgm.id) as member_count,
      SUM(CASE WHEN latest.status = 'running' THEN 1 ELSE 0 END) as running_count,
      ROUND(SUM(latest.cpu_percent), 1) as total_cpu,
      ROUND(SUM(latest.memory_mb)) as total_memory
    FROM service_groups sg
    LEFT JOIN service_group_members sgm ON sg.id = sgm.group_id
    LEFT JOIN latest ON latest.host_id = sgm.host_id AND latest.container_name = sgm.container_name
    GROUP BY sg.id
    ORDER BY sg.name
  `).all() as GroupRow[];
  if (showInternal) return groups;

  // Hide groups where ALL members are internal (the "insightd" compose group).
  // One query returns every (group_id, labels) pair so we avoid an N-per-group
  // subquery. Map group_id → labels[] in memory and decide per group.
  const memberLabels = db.prepare(`
    WITH latest AS (
      SELECT cs.host_id, cs.container_name, cs.labels
      FROM container_snapshots cs
      INNER JOIN (
        SELECT host_id, container_name, MAX(collected_at) AS max_at
        FROM container_snapshots
        WHERE collected_at >= datetime('now', '-1 day')
        GROUP BY host_id, container_name
      ) m ON m.host_id = cs.host_id
         AND m.container_name = cs.container_name
         AND m.max_at = cs.collected_at
    )
    SELECT sgm.group_id, latest.labels
    FROM service_group_members sgm
    LEFT JOIN latest ON latest.host_id = sgm.host_id AND latest.container_name = sgm.container_name
  `).all() as Array<{ group_id: number; labels: string | null }>;

  const labelsByGroup = new Map<number, Array<string | null>>();
  for (const row of memberLabels) {
    const arr = labelsByGroup.get(row.group_id) ?? [];
    arr.push(row.labels);
    labelsByGroup.set(row.group_id, arr);
  }

  return groups.filter(g => {
    const members = labelsByGroup.get(g.id as unknown as number) ?? [];
    if (members.length === 0) return true;
    const allInternal = members.every(labels => {
      if (!labels) return false;
      try { return JSON.parse(labels)['insightd.internal'] === 'true'; } catch { return false; }
    });
    return !allInternal;
  });
}

function getGroup(db: Database.Database, id: number): GroupBasicRow | null {
  return (db.prepare('SELECT * FROM service_groups WHERE id = ?').get(id) as GroupBasicRow | undefined) || null;
}

function getGroupDetail(db: Database.Database, id: number): (GroupBasicRow & { members: GroupMemberRow[] }) | null {
  const group = getGroup(db, id);
  if (!group) return null;

  const members = db.prepare(`
    SELECT sgm.host_id, sgm.container_name, sgm.source,
      cs.container_id, cs.status, cs.cpu_percent, cs.memory_mb,
      cs.restart_count, cs.health_status, cs.collected_at
    FROM service_group_members sgm
    LEFT JOIN (
      SELECT host_id, container_name, container_id, status, cpu_percent, memory_mb,
        restart_count, health_status, collected_at,
        ROW_NUMBER() OVER (PARTITION BY host_id, container_name ORDER BY collected_at DESC) as rn
      FROM container_snapshots
    ) cs ON cs.host_id = sgm.host_id AND cs.container_name = sgm.container_name AND cs.rn = 1
    WHERE sgm.group_id = ?
    ORDER BY sgm.host_id, sgm.container_name
  `).all(id) as GroupMemberRow[];

  return { ...group, members };
}

function createGroup(db: Database.Database, data: GroupCreateData): { id: number | bigint } {
  const result = db.prepare(`
    INSERT INTO service_groups (name, description, icon, color, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.name, data.description || null, data.icon || null, data.color || null, data.source || 'manual');
  return { id: result.lastInsertRowid };
}

function updateGroup(db: Database.Database, id: number, data: GroupUpdateData): { updated: boolean } {
  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description ?? null); }
  if (data.icon !== undefined) { fields.push('icon = ?'); values.push(data.icon ?? null); }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color ?? null); }

  if (fields.length === 0) return { updated: false };

  fields.push("updated_at = datetime('now')");
  values.push(id as any);

  const result = db.prepare(`UPDATE service_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { updated: result.changes > 0 };
}

function deleteGroup(db: Database.Database, id: number): { deleted: boolean } {
  const result = db.prepare('DELETE FROM service_groups WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

function addGroupMember(db: Database.Database, groupId: number, hostId: string, containerName: string, source: string = 'manual'): { added: boolean; error?: string } {
  try {
    db.prepare(`
      INSERT INTO service_group_members (group_id, host_id, container_name, source)
      VALUES (?, ?, ?, ?)
    `).run(groupId, hostId, containerName, source);
    return { added: true };
  } catch {
    return { added: false, error: 'Already a member' };
  }
}

function removeGroupMember(db: Database.Database, groupId: number, hostId: string, containerName: string): { removed: boolean } {
  const result = db.prepare(
    'DELETE FROM service_group_members WHERE group_id = ? AND host_id = ? AND container_name = ?'
  ).run(groupId, hostId, containerName);
  return { removed: result.changes > 0 };
}

function getContainerGroups(db: Database.Database, hostId: string, containerName: string): GroupBasicRow[] {
  return db.prepare(`
    SELECT sg.* FROM service_groups sg
    JOIN service_group_members sgm ON sg.id = sgm.group_id
    WHERE sgm.host_id = ? AND sgm.container_name = ?
    ORDER BY sg.name
  `).all(hostId, containerName) as GroupBasicRow[];
}

/**
 * Auto-assign containers to groups based on Docker labels.
 * Called during ingest after storing container snapshots.
 */
function autoAssignGroups(db: Database.Database, hostId: string, containers: ContainerData[]): void {
  for (const c of containers) {
    // Skip temporary containers from updates
    if (c.name.endsWith('-old') || c.name.endsWith('-removing')) continue;

    let labels: Record<string, string>;
    try {
      labels = typeof c.labels === 'string' ? JSON.parse(c.labels) : (c.labels || {});
    } catch { continue; }

    const explicitGroup = labels['insightd.group'];
    const composeProject = labels['com.docker.compose.project'];

    if (explicitGroup) {
      ensureGroupMembership(db, explicitGroup, hostId, c.name, 'label');
    }
    if (composeProject) {
      ensureGroupMembership(db, composeProject, hostId, c.name, 'compose');
    }
  }
}

function ensureGroupMembership(db: Database.Database, groupName: string, hostId: string, containerName: string, source: string): void {
  // Check if a manual membership already exists
  const existingManual = db.prepare(`
    SELECT 1 FROM service_group_members sgm
    JOIN service_groups sg ON sg.id = sgm.group_id
    WHERE sg.name = ? AND sgm.host_id = ? AND sgm.container_name = ? AND sgm.source = 'manual'
  `).get(groupName, hostId, containerName);

  if (existingManual) return;

  // Upsert the group
  db.prepare('INSERT INTO service_groups (name, source) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(groupName, source);
  const group = db.prepare('SELECT id FROM service_groups WHERE name = ?').get(groupName) as GroupIdRow | undefined;
  if (!group) return;

  // Upsert membership (don't overwrite manual)
  db.prepare(`
    INSERT INTO service_group_members (group_id, host_id, container_name, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, host_id, container_name) DO UPDATE SET source = excluded.source
    WHERE service_group_members.source != 'manual'
  `).run(group.id, hostId, containerName, source);
}

module.exports = { getGroups, getGroup, getGroupDetail, createGroup, updateGroup, deleteGroup, addGroupMember, removeGroupMember, getContainerGroups, autoAssignGroups };
