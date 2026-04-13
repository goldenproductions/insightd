/**
 * Personalized PageRank (PPR) for root-cause ranking.
 *
 * Seeds the random walk at the symptom entity and returns the top-K
 * neighbors ranked by their stationary probability — an honest "these
 * nodes are structurally close to the symptom and their metrics correlate"
 * signal. Used by Phase 3's correlation diagnoser.
 *
 * Graph shape (see `rca/graph.ts`):
 *   - Nodes are entity IDs: `"host/container"` or `"host"` strings.
 *   - Edges have a type (`same_host` / `same_compose` / `same_group` /
 *     `metric_corr`) and a weight in [0,1]. Multiple edges can exist
 *     between the same pair — we aggregate their weight at walk time.
 *
 * Algorithm (classic random-walk-with-restart):
 *   r[i+1] = (1-α) · seed + α · M · r[i]
 * where M is the row-normalized adjacency and α is the transport probability.
 * Converges in O(iterations) time per node.
 */

import type { Neighbor, PPRResult } from '../diagnosis/types';

export interface EdgeRow {
  from: string;
  to: string;
  type: string;
  weight: number;
}

export interface PPROptions {
  /** Teleport-probability complement. Typical: 0.15 = 15% teleport, 85% walk. */
  alpha?: number;
  /** Number of power-iteration steps. 30 is plenty for homelab graphs (<500 nodes). */
  iterations?: number;
  /** How many neighbors to return (excluding the seed itself). */
  topK?: number;
}

const DEFAULT_OPTS: Required<PPROptions> = {
  alpha: 0.85,
  iterations: 30,
  topK: 5,
};

interface AdjEntry {
  to: string;
  weight: number;
  edgeTypes: string[];
}

/**
 * Build an adjacency map from edge rows, summing weights when multiple
 * edges connect the same pair, and remembering the edge types so we can
 * tell the user *why* two nodes are connected.
 */
function buildAdjacency(edges: EdgeRow[]): Map<string, AdjEntry[]> {
  const adj = new Map<string, Map<string, AdjEntry>>();
  const addEdge = (from: string, to: string, type: string, weight: number) => {
    if (!adj.has(from)) adj.set(from, new Map());
    const inner = adj.get(from)!;
    const existing = inner.get(to);
    if (existing) {
      existing.weight += weight;
      if (!existing.edgeTypes.includes(type)) existing.edgeTypes.push(type);
    } else {
      inner.set(to, { to, weight, edgeTypes: [type] });
    }
  };
  for (const e of edges) {
    addEdge(e.from, e.to, e.type, e.weight);
    addEdge(e.to, e.from, e.type, e.weight); // symmetric
  }
  const out = new Map<string, AdjEntry[]>();
  for (const [k, inner] of adj) out.set(k, [...inner.values()]);
  return out;
}

/**
 * Run personalized PageRank seeded at a single node.
 */
export function personalizedPageRank(
  edges: EdgeRow[],
  seed: string,
  options: PPROptions = {},
): PPRResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  const adj = buildAdjacency(edges);

  // Collect all nodes (including isolated ones that only appear as edge targets).
  const allNodes = new Set<string>([seed]);
  for (const [from, neighbors] of adj) {
    allNodes.add(from);
    for (const n of neighbors) allNodes.add(n.to);
  }

  if (!allNodes.has(seed) || allNodes.size < 2) {
    return { seed, neighbors: [] };
  }

  // Initial rank: all mass at the seed.
  let rank = new Map<string, number>();
  for (const n of allNodes) rank.set(n, 0);
  rank.set(seed, 1);

  for (let iter = 0; iter < opts.iterations; iter++) {
    const next = new Map<string, number>();
    for (const n of allNodes) next.set(n, 0);

    // Teleport component: (1-α) of the seed's mass lands back at the seed.
    next.set(seed, (1 - opts.alpha));

    // Walk component: α · (row-normalized neighbors of each node).
    for (const [node, r] of rank) {
      if (r === 0) continue;
      const neighbors = adj.get(node);
      if (!neighbors || neighbors.length === 0) {
        // Dead end: teleport back to seed.
        next.set(seed, (next.get(seed) ?? 0) + opts.alpha * r);
        continue;
      }
      let totalW = 0;
      for (const e of neighbors) totalW += e.weight;
      if (totalW === 0) {
        next.set(seed, (next.get(seed) ?? 0) + opts.alpha * r);
        continue;
      }
      for (const e of neighbors) {
        const share = opts.alpha * r * (e.weight / totalW);
        next.set(e.to, (next.get(e.to) ?? 0) + share);
      }
    }
    rank = next;
  }

  // Rank neighbors excluding the seed and any zero-score entries.
  const ranked: Neighbor[] = [];
  for (const [node, score] of rank) {
    if (node === seed) continue;
    if (score <= 1e-6) continue;
    const neighbors = adj.get(seed) ?? [];
    const direct = neighbors.find((n) => n.to === node);
    ranked.push({
      entityId: node,
      score: Math.round(score * 10000) / 10000,
      edgeTypes: direct ? direct.edgeTypes : [],
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { seed, neighbors: ranked.slice(0, opts.topK) };
}

module.exports = { personalizedPageRank };
