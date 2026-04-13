/**
 * In-memory log cache for diagnosis framework.
 *
 * Log fetching is a synchronous MQTT round-trip (15s timeout) — too expensive
 * to do synchronously on every container detail page load. This cache stores
 * recent logs per container with a 5-minute TTL, so repeat views of an
 * unhealthy container are fast and diagnosis gets log signals.
 *
 * Strategy:
 *   - On container detail load: check cache. If hit, use it. If miss, fire
 *     a background fetch (fire-and-forget) so the next view is enriched.
 *   - On unhealthy transition detected in MQTT ingest: pre-warm the cache
 *     so diagnosis has logs by the time someone looks.
 *
 * Template mining: when logs are written to the cache and a `LogCacheContext`
 * is provided (carrying a DB handle + the container's image name), each line
 * is run through a Drain parse tree. Templates are persisted per image in the
 * `log_templates` table, and the batch's hits / new templates / bursts are
 * attached to the cache entry so diagnosers can consume them.
 */

import type Database from 'better-sqlite3';
import type {
  DiagnosisLogs,
  DiagnosisLogEntry,
  TemplateHit,
  TemplateBurst,
} from './types';
import { DrainTree, tokenize, type DrainTemplate } from './drain';
import { classifyTemplate } from './templateClassifier';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LINES_PER_CACHE_ENTRY = 100;
const BURST_MIN_COUNT = 3;

interface CacheEntry {
  lines: DiagnosisLogEntry[];
  fetchedAt: number;
  errorPatterns: string[];
  templates: TemplateHit[];
  unseenTemplates: number;
  templateBursts: TemplateBurst[];
}

const cache = new Map<string, CacheEntry>();
const pendingFetches = new Set<string>();

function cacheKey(hostId: string, containerName: string): string {
  return `${hostId}/${containerName}`;
}

/**
 * Optional context for template mining at cache-write time. When omitted
 * (e.g. from test fixtures), the cache still stores the raw lines but does
 * no template mining and `templates` / `templateBursts` come back empty.
 */
export interface LogCacheContext {
  db: Database.Database;
  /**
   * Image scoping key for Drain templates. When available (from the MQTT
   * collection payload), the real image name ensures multiple containers
   * running the same image share their template tree. Falls back to the
   * container name when null.
   */
  image: string | null;
}

interface LoadedTemplate extends DrainTemplate {
  id: number;
  lastSeen: string;
  firstSeen: string;
}

function loadTemplates(db: Database.Database, imageKey: string): LoadedTemplate[] {
  const rows = db.prepare(`
    SELECT id, image, template_hash, template, token_count,
           occurrence_count, semantic_tag, first_seen, last_seen
    FROM log_templates
    WHERE image = ?
  `).all(imageKey) as Array<{
    id: number;
    template_hash: string;
    template: string;
    token_count: number;
    occurrence_count: number;
    semantic_tag: string | null;
    first_seen: string;
    last_seen: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    templateHash: r.template_hash,
    template: r.template,
    tokenCount: r.token_count,
    occurrenceCount: r.occurrence_count,
    semanticTag: r.semantic_tag,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}

interface TemplateMiningResult {
  templates: TemplateHit[];
  errorPatterns: string[];
  unseenTemplates: number;
  templateBursts: TemplateBurst[];
}

/**
 * Run Drain over a batch of log lines scoped to a given image key. Persists
 * new and updated templates in `log_templates` and returns the per-batch
 * summary for the cache entry.
 */
function mineTemplates(
  db: Database.Database,
  imageKey: string,
  lines: DiagnosisLogEntry[],
): TemplateMiningResult {
  const seedTemplates = loadTemplates(db, imageKey);
  const priorById = new Map(seedTemplates.map((t) => [t.templateHash, t] as const));

  const tree = new DrainTree(seedTemplates);
  const hits = new Map<string, TemplateHit>();

  for (const line of lines) {
    const msg = line.message || '';
    if (!msg) continue;
    const tokens = tokenize(msg);
    if (tokens.length === 0) continue;
    const match = tree.match(tokens);
    const existing = hits.get(match.templateHash);
    if (existing) {
      existing.count += 1;
    } else {
      const prior = priorById.get(match.templateHash);
      const semanticTag = prior?.semanticTag ?? classifyTemplate(match.template);
      hits.set(match.templateHash, {
        templateHash: match.templateHash,
        template: match.template,
        count: 1,
        semanticTag,
        isNew: !prior,
      });
    }
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const upsert = db.prepare(`
    INSERT INTO log_templates
      (image, template_hash, template, token_count, semantic_tag, first_seen, last_seen, occurrence_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(image, template_hash) DO UPDATE SET
      template = excluded.template,
      last_seen = excluded.last_seen,
      occurrence_count = log_templates.occurrence_count + excluded.occurrence_count
  `);

  const tx = db.transaction((rows: TemplateHit[]) => {
    for (const hit of rows) {
      upsert.run(
        imageKey,
        hit.templateHash,
        hit.template,
        hit.template.split(/\s+/).filter(Boolean).length,
        hit.semanticTag,
        now,
        now,
        hit.count,
      );
    }
  });

  const hitsArray = [...hits.values()];
  try {
    tx(hitsArray);
  } catch {
    // Template persistence is best-effort; diagnosis still works off the
    // in-memory Drain match even if the upsert fails.
  }

  const errorPatterns: string[] = [];
  const seenTags = new Set<string>();
  for (const hit of hitsArray) {
    if (hit.semanticTag && !seenTags.has(hit.semanticTag)) {
      seenTags.add(hit.semanticTag);
      errorPatterns.push(hit.semanticTag);
    }
  }

  const unseenTemplates = hitsArray.filter((h) => h.isNew).length;
  const templateBursts: TemplateBurst[] = hitsArray
    .filter((h) => h.count >= BURST_MIN_COUNT && (h.isNew || h.semanticTag))
    .map((h) => ({
      templateHash: h.templateHash,
      template: h.template,
      burstCount: h.count,
      semanticTag: h.semanticTag,
    }));

  return {
    templates: hitsArray.sort((a, b) => b.count - a.count),
    errorPatterns,
    unseenTemplates,
    templateBursts,
  };
}

const EMPTY_MINING: TemplateMiningResult = {
  templates: [],
  errorPatterns: [],
  unseenTemplates: 0,
  templateBursts: [],
};

/**
 * Get cached logs for a container. Returns an empty (unavailable) entry if
 * nothing is cached or the entry has expired.
 */
export function getCachedLogs(hostId: string, containerName: string): DiagnosisLogs {
  const key = cacheKey(hostId, containerName);
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    return {
      available: false,
      lines: [],
      errorPatterns: [],
      templates: [],
      unseenTemplates: 0,
      templateBursts: [],
      fetchedAt: null,
    };
  }
  return {
    available: true,
    lines: entry.lines,
    errorPatterns: entry.errorPatterns,
    templates: entry.templates,
    unseenTemplates: entry.unseenTemplates,
    templateBursts: entry.templateBursts,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
  };
}

/**
 * Store logs in the cache. When a mining context is provided, each line is
 * also fed through Drain and templates are persisted to `log_templates`.
 */
export function setCachedLogs(
  hostId: string,
  containerName: string,
  lines: DiagnosisLogEntry[],
  ctx?: LogCacheContext,
): void {
  const key = cacheKey(hostId, containerName);
  const trimmed = lines.slice(-MAX_LINES_PER_CACHE_ENTRY);
  let mining: TemplateMiningResult = EMPTY_MINING;
  if (ctx && ctx.db) {
    const imageKey = ctx.image && ctx.image.length > 0 ? ctx.image : containerName;
    try {
      mining = mineTemplates(ctx.db, imageKey, trimmed);
    } catch {
      mining = EMPTY_MINING;
    }
  }
  cache.set(key, {
    lines: trimmed,
    fetchedAt: Date.now(),
    errorPatterns: mining.errorPatterns,
    templates: mining.templates,
    unseenTemplates: mining.unseenTemplates,
    templateBursts: mining.templateBursts,
  });
}

/**
 * Fire-and-forget log fetch. Never throws. Updates the cache on success.
 *
 * @param requestLogs — the MQTT log request function (from hub/src/mqtt.ts)
 * @param ctx — optional mining context; when provided, fetched logs feed Drain
 */
export function fetchLogsBackground(
  hostId: string,
  containerName: string,
  containerId: string,
  requestLogs: (hostId: string, containerId: string, options: { lines: number; stream: string }) => Promise<DiagnosisLogEntry[]>,
  ctx?: LogCacheContext,
): void {
  const key = cacheKey(hostId, containerName);
  if (pendingFetches.has(key)) return; // already in flight
  pendingFetches.add(key);

  (async () => {
    try {
      const lines = await requestLogs(hostId, containerId, { lines: 100, stream: 'both' });
      setCachedLogs(hostId, containerName, lines, ctx);
    } catch {
      // Swallow errors — log fetching is best-effort
    } finally {
      pendingFetches.delete(key);
    }
  })();
}

/**
 * Clear the cache entry for a container. Useful when the container has been
 * restarted and we want fresh logs.
 */
export function invalidateLogs(hostId: string, containerName: string): void {
  cache.delete(cacheKey(hostId, containerName));
}

/**
 * Testing helper — clear the entire cache.
 */
export function _clearCache(): void {
  cache.clear();
  pendingFetches.clear();
}

/**
 * Best-effort image-key lookup for callers that don't have the image at hand
 * (e.g. the container detail HTTP path). Checks `update_checks` for the most
 * recent image recorded for this container, falling back to the container
 * name when the update checker hasn't scanned it yet.
 */
export function resolveImageKey(
  db: Database.Database,
  hostId: string,
  containerName: string,
): string {
  try {
    const row = db.prepare(`
      SELECT image FROM update_checks
      WHERE host_id = ? AND container_name = ?
      ORDER BY checked_at DESC
      LIMIT 1
    `).get(hostId, containerName) as { image: string } | undefined;
    if (row && row.image) {
      // Strip tag / digest so `nginx:1.25` and `nginx:1.26` share templates.
      return row.image.split('@')[0].split(':')[0] || containerName;
    }
  } catch {
    // ignore — resolver is best-effort
  }
  return containerName;
}

module.exports = {
  getCachedLogs,
  setCachedLogs,
  fetchLogsBackground,
  invalidateLogs,
  resolveImageKey,
  _clearCache,
};
