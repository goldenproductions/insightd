/**
 * Drain log template mining (He et al., ICWS 2017).
 *
 * An online log parser that clusters raw log lines into templates via a
 * fixed-depth parse tree. Variable tokens (numbers, uuids, ips) are masked
 * to `<*>` during tokenization so that `"Connected client 10.0.0.4 in 32ms"`
 * and `"Connected client 10.0.0.7 in 41ms"` collapse into a single template:
 * `Connected client <*> in <*>ms`.
 *
 * This module is pure: the tree is built from a list of templates (typically
 * loaded from the `log_templates` table), fed new log lines, and reports which
 * templates matched and which are new. Persistence happens at the call site.
 */

import { createHash } from 'crypto';

export interface DrainTemplate {
  templateHash: string;
  template: string;
  tokenCount: number;
  occurrenceCount: number;
  semanticTag: string | null;
}

export interface DrainTreeOptions {
  depth?: number;
  similarityThreshold?: number;
  maxChildren?: number;
}

export interface MatchResult {
  templateHash: string;
  template: string;
  tokenCount: number;
  semanticTag: string | null;
  isNew: boolean;
}

const DEFAULT_OPTS: Required<DrainTreeOptions> = {
  depth: 4,
  similarityThreshold: 0.5,
  maxChildren: 100,
};

const WILDCARD = '<*>';

const MASK_RULES: Array<{ re: RegExp; mask: string }> = [
  // IPv4 (with optional port)
  { re: /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/, mask: WILDCARD },
  // IPv6 (loose — catches `[::1]`, `fe80::1`, etc.)
  { re: /^\[?[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\]?(:\d+)?$/i, mask: WILDCARD },
  // UUID
  { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, mask: WILDCARD },
  // Hex digest (≥8 chars, all hex) — container ids, short shas, etc.
  { re: /^[0-9a-f]{8,}$/i, mask: WILDCARD },
  // Pure number (int or float), optionally with a unit suffix like `32ms` / `1.5s`
  { re: /^-?\d+(\.\d+)?(ms|s|us|ns|kb|mb|gb|tb|b|%)?$/i, mask: WILDCARD },
  // ISO timestamps (e.g. 2026-04-13T10:21:00Z)
  { re: /^\d{4}-\d{2}-\d{2}t?\d{0,2}:?\d{0,2}:?\d{0,2}(\.\d+)?z?$/i, mask: WILDCARD },
];

/**
 * Tokenize a log line by splitting on whitespace and masking variable tokens
 * (numbers, ips, uuids, timestamps, hex digests) to `<*>`.
 */
export function tokenize(line: string): string[] {
  const raw = line.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of raw) {
    // Strip trailing punctuation that commonly follows values — but NOT colons,
    // since log-level prefixes like `FATAL:` / `panic:` are semantically
    // meaningful and the classifier regexes match on them.
    const trimmed = tok.replace(/[,;.]$/, '');
    let masked = trimmed;
    for (const { re, mask } of MASK_RULES) {
      if (re.test(trimmed)) {
        masked = mask;
        break;
      }
    }
    out.push(masked);
  }
  return out;
}

/**
 * Compute a stable hash for a token sequence. Used as the template identity
 * key so the same template from different runs collides correctly.
 */
export function hashTemplate(tokens: string[]): string {
  const h = createHash('sha1');
  h.update(tokens.join('\u0001'));
  return h.digest('hex').slice(0, 16);
}

interface Cluster {
  template: string[];
  hash: string;
}

interface Node {
  clusters: Cluster[];
  children: Map<string, Node>;
}

function makeNode(): Node {
  return { clusters: [], children: new Map() };
}

/**
 * An online Drain parse tree. Seed with existing templates, then call
 * `match(tokens)` for each log line. Returned `isNew` tells the caller whether
 * the template needs to be persisted.
 */
export class DrainTree {
  private readonly opts: Required<DrainTreeOptions>;
  // Top-level bucket: first-level dispatch on token count.
  private readonly rootsByLength = new Map<number, Node>();

  constructor(seed: DrainTemplate[] = [], opts: DrainTreeOptions = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    for (const t of seed) {
      const toks = t.template.split(/\s+/).filter(Boolean);
      if (toks.length === 0) continue;
      const leaf = this.walk(toks, /*createMissing*/ true);
      leaf.clusters.push({ template: toks, hash: t.templateHash });
    }
  }

  /**
   * Match a token sequence against the tree, inserting a new cluster when no
   * similar existing cluster is found.
   */
  match(tokens: string[]): MatchResult {
    if (tokens.length === 0) {
      return {
        templateHash: hashTemplate(['<empty>']),
        template: '<empty>',
        tokenCount: 0,
        semanticTag: null,
        isNew: false,
      };
    }

    const leaf = this.walk(tokens, /*createMissing*/ true);

    // Find best-matching cluster in the leaf by similarity.
    let best: { cluster: Cluster; sim: number } | null = null;
    for (const cluster of leaf.clusters) {
      if (cluster.template.length !== tokens.length) continue;
      const sim = similarity(cluster.template, tokens);
      if (sim >= this.opts.similarityThreshold && (!best || sim > best.sim)) {
        best = { cluster, sim };
      }
    }

    if (best) {
      mergeTokens(best.cluster.template, tokens);
      return {
        templateHash: best.cluster.hash,
        template: best.cluster.template.join(' '),
        tokenCount: best.cluster.template.length,
        semanticTag: null,
        isNew: false,
      };
    }

    // Create a new cluster with this token sequence as its template.
    const cluster: Cluster = {
      template: [...tokens],
      hash: hashTemplate(tokens),
    };
    leaf.clusters.push(cluster);
    return {
      templateHash: cluster.hash,
      template: cluster.template.join(' '),
      tokenCount: cluster.template.length,
      semanticTag: null,
      isNew: true,
    };
  }

  /**
   * Walk the tree to the leaf node for a given token sequence, creating
   * intermediate nodes as necessary.
   */
  private walk(tokens: string[], createMissing: boolean): Node {
    const len = tokens.length;
    let node: Node;
    const rootNode = this.rootsByLength.get(len);
    if (rootNode) {
      node = rootNode;
    } else {
      if (!createMissing) return makeNode();
      node = makeNode();
      this.rootsByLength.set(len, node);
    }

    const depth = Math.min(this.opts.depth, len);
    for (let d = 0; d < depth; d++) {
      const tok = tokens[d] ?? WILDCARD;
      // Prefer exact child, fall back to wildcard child.
      let child: Node | undefined = node.children.get(tok) ?? node.children.get(WILDCARD);
      if (!child) {
        if (!createMissing) return node;
        if (node.children.size < this.opts.maxChildren) {
          child = makeNode();
          node.children.set(tok, child);
        } else {
          const wildcard = node.children.get(WILDCARD);
          if (wildcard) {
            child = wildcard;
          } else {
            child = makeNode();
            node.children.set(WILDCARD, child);
          }
        }
      }
      node = child;
    }
    return node;
  }
}

/**
 * Token-level similarity: fraction of positions where the cluster's template
 * token matches the incoming token (wildcards match anything).
 */
function similarity(template: string[], tokens: string[]): number {
  if (template.length !== tokens.length || template.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === WILDCARD || template[i] === tokens[i]) matches++;
  }
  return matches / template.length;
}

/**
 * Merge an incoming token sequence into an existing template by replacing
 * positions that disagree with the wildcard token. The cluster's template is
 * mutated in place; the hash is NOT recomputed (identity is frozen at cluster
 * creation time, so templates only become *more* general over time).
 */
function mergeTokens(template: string[], tokens: string[]): void {
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== WILDCARD && template[i] !== tokens[i]) {
      template[i] = WILDCARD;
    }
  }
}

module.exports = {
  DrainTree,
  tokenize,
  hashTemplate,
};
