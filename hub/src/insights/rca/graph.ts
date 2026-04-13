/**
 * Implicit service-topology graph for RCA.
 *
 * Homelab deployments don't have a distributed-tracing service mesh, so we
 * build an *implicit* graph from the signals we already collect:
 *
 *   - `same_host` — every pair of containers on the same host (cheap, always
 *     present). Low weight since co-location alone is weak evidence.
 *   - `same_compose` — containers sharing a `com.docker.compose.project`
 *     label. Stronger signal: compose stacks typically depend on each other.
 *   - `same_group` — containers sharing a service_group (user-defined or
 *     compose-auto-assigned). Strongest static signal.
 *   - `metric_corr` — dynamic correlation between two containers' CPU/memory
 *     over the last 2 hours of hourly rollups. Only computed between pairs
 *     that already share a host OR compose project (pruning O(C²) to ≪1%).
 *
 * This module is the producer. Phase 3's correlation diagnoser (via
 * `ppr.ts`) reads from `rca_edges` at diagnosis time.
 */

import type Database from 'better-sqlite3';
import logger = require('../../../../shared/utils/logger');
import { pearson } from '../stats';

const CORR_WINDOW_HOURS = 48;
const CORR_MIN_SAMPLES = 12;
const CORR_MIN_STRENGTH = 0.4;

const BASE_WEIGHTS = {
  same_host: 0.3,
  same_compose: 0.6,
  same_group: 0.7,
} as const;

interface ContainerRow {
  host_id: string;
  container_name: string;
  labels: string | null;
}

interface MemberRow {
  group_id: number;
  host_id: string;
  container_name: string;
}

interface RollupRow {
  bucket: string;
  cpu: number | null;
  mem: number | null;
}

function containerEntity(hostId: string, name: string): string {
  return `${hostId}/${name}`;
}

function parseComposeProject(labels: string | null): string | null {
  if (!labels) return null;
  try {
    const parsed = JSON.parse(labels) as Record<string, string>;
    return parsed['com.docker.compose.project'] ?? null;
  } catch {
    return null;
  }
}

/**
 * Load all containers seen in the last hour — effectively the "live" set.
 */
function loadLiveContainers(db: Database.Database): ContainerRow[] {
  return db.prepare(`
    SELECT DISTINCT host_id, container_name, labels FROM container_snapshots
    WHERE collected_at >= datetime('now', '-1 hour')
  `).all() as ContainerRow[];
}

function loadGroupMembers(db: Database.Database): MemberRow[] {
  return db.prepare(`
    SELECT group_id, host_id, container_name FROM service_group_members
  `).all() as MemberRow[];
}

function loadCorrelationSeries(
  db: Database.Database,
  hostId: string,
  containerName: string,
): { cpu: number[]; mem: number[] } {
  const rows = db.prepare(`
    SELECT bucket, cpu_max AS cpu, mem_max AS mem
    FROM container_rollups
    WHERE host_id = ? AND container_name = ?
      AND bucket >= datetime('now', '-${CORR_WINDOW_HOURS} hours')
    ORDER BY bucket ASC
  `).all(hostId, containerName) as RollupRow[];
  return {
    cpu: rows.map((r) => r.cpu ?? 0),
    mem: rows.map((r) => r.mem ?? 0),
  };
}

interface EdgeKey {
  from: string;
  to: string;
  type: string;
}

function keyOf(k: EdgeKey): string {
  return `${k.from}\u0001${k.to}\u0001${k.type}`;
}

/**
 * Build the topology + correlation graph from DB state and replace
 * `rca_edges` atomically. Intended to be called from the scheduler — not
 * on the hot diagnosis path.
 */
export function buildGraph(db: Database.Database): number {
  const containers = loadLiveContainers(db);
  if (containers.length === 0) {
    logger.info('rca', 'No live containers — skipping graph build');
    return 0;
  }

  const entityOf = (c: ContainerRow) => containerEntity(c.host_id, c.container_name);

  // Group containers by host and compose project for the cheap static edges.
  const byHost = new Map<string, ContainerRow[]>();
  const byCompose = new Map<string, ContainerRow[]>();
  for (const c of containers) {
    if (!byHost.has(c.host_id)) byHost.set(c.host_id, []);
    byHost.get(c.host_id)!.push(c);
    const project = parseComposeProject(c.labels);
    if (project) {
      const key = `${c.host_id}:${project}`;
      if (!byCompose.has(key)) byCompose.set(key, []);
      byCompose.get(key)!.push(c);
    }
  }

  // Service-group membership (loaded once).
  const members = loadGroupMembers(db);
  const byGroup = new Map<number, MemberRow[]>();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id)!.push(m);
  }

  // Emit edges to a map keyed by (from,to,type). Same-host + same-compose
  // + same-group are dense and cheap; metric correlation is limited to
  // pairs that already share a static edge.
  const edges = new Map<string, { row: EdgeKey; weight: number }>();
  const addEdge = (from: string, to: string, type: string, weight: number) => {
    if (from === to) return;
    const a = from < to ? from : to;
    const b = from < to ? to : from;
    const row: EdgeKey = { from: a, to: b, type };
    const k = keyOf(row);
    const existing = edges.get(k);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
    } else {
      edges.set(k, { row, weight });
    }
  };

  // Same-host edges — O(C²) per host, but host-local.
  const correlationPairs = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);

  for (const [, list] of byHost) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = entityOf(list[i]!);
        const b = entityOf(list[j]!);
        addEdge(a, b, 'same_host', BASE_WEIGHTS.same_host);
        correlationPairs.add(pairKey(a, b));
      }
    }
  }

  // Same-compose edges.
  for (const [, list] of byCompose) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = entityOf(list[i]!);
        const b = entityOf(list[j]!);
        addEdge(a, b, 'same_compose', BASE_WEIGHTS.same_compose);
        correlationPairs.add(pairKey(a, b));
      }
    }
  }

  // Same-service-group edges.
  for (const [, list] of byGroup) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = containerEntity(list[i]!.host_id, list[i]!.container_name);
        const b = containerEntity(list[j]!.host_id, list[j]!.container_name);
        addEdge(a, b, 'same_group', BASE_WEIGHTS.same_group);
        correlationPairs.add(pairKey(a, b));
      }
    }
  }

  // Metric correlations — only on pairs that already share a static edge,
  // which keeps the O(C²) work bounded by the structural connectivity.
  const seriesCache = new Map<string, { cpu: number[]; mem: number[] }>();
  const getSeries = (c: ContainerRow) => {
    const e = entityOf(c);
    if (!seriesCache.has(e)) seriesCache.set(e, loadCorrelationSeries(db, c.host_id, c.container_name));
    return seriesCache.get(e)!;
  };

  const containersByEntity = new Map<string, ContainerRow>();
  for (const c of containers) containersByEntity.set(entityOf(c), c);

  for (const pair of correlationPairs) {
    const [aId, bId] = pair.split('\u0001');
    if (!aId || !bId) continue;
    const ac = containersByEntity.get(aId);
    const bc = containersByEntity.get(bId);
    if (!ac || !bc) continue;
    const a = getSeries(ac);
    const b = getSeries(bc);
    const n = Math.min(a.cpu.length, b.cpu.length);
    if (n < CORR_MIN_SAMPLES) continue;
    const cpuCorr = pearson(a.cpu.slice(0, n), b.cpu.slice(0, n)) ?? 0;
    const memCorr = pearson(a.mem.slice(0, n), b.mem.slice(0, n)) ?? 0;
    const corr = Math.max(cpuCorr, memCorr);
    if (corr >= CORR_MIN_STRENGTH) {
      addEdge(aId, bId, 'metric_corr', Math.min(1, corr));
    }
  }

  // Replace rca_edges atomically.
  const tx = db.transaction(() => {
    db.exec('DELETE FROM rca_edges');
    const insert = db.prepare(`
      INSERT INTO rca_edges (from_entity, to_entity, edge_type, weight)
      VALUES (?, ?, ?, ?)
    `);
    for (const { row, weight } of edges.values()) {
      insert.run(row.from, row.to, row.type, weight);
    }
  });
  tx();

  if (edges.size > 0) {
    logger.info('rca', `Built RCA graph: ${edges.size} edges across ${containers.length} containers`);
  }
  return edges.size;
}

/**
 * Load all edges from the DB into the format PPR expects.
 */
export function loadEdges(db: Database.Database): Array<{ from: string; to: string; type: string; weight: number }> {
  return db.prepare(`
    SELECT from_entity AS "from", to_entity AS "to", edge_type AS type, weight
    FROM rca_edges
  `).all() as Array<{ from: string; to: string; type: string; weight: number }>;
}

module.exports = { buildGraph, loadEdges };
