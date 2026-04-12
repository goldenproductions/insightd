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
 */

import type { DiagnosisLogs, DiagnosisLogEntry } from './types';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LINES_PER_CACHE_ENTRY = 100;

interface CacheEntry {
  lines: DiagnosisLogEntry[];
  fetchedAt: number;
  errorPatterns: string[];
}

const cache = new Map<string, CacheEntry>();
const pendingFetches = new Set<string>();

function cacheKey(hostId: string, containerName: string): string {
  return `${hostId}/${containerName}`;
}

/**
 * Pre-defined patterns to extract from log lines. Case-insensitive.
 * Each pattern gets a short human-readable label.
 */
const LOG_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /out of memory|oom[-_ ]?killed|cannot allocate memory/i, label: 'out of memory' },
  { re: /panic:/i, label: 'panic' },
  { re: /segmentation fault|sigsegv/i, label: 'segmentation fault' },
  { re: /fatal:/i, label: 'fatal error' },
  { re: /connection refused/i, label: 'connection refused' },
  { re: /connection reset/i, label: 'connection reset' },
  { re: /i\/o timeout|connection timed out/i, label: 'connection timeout' },
  { re: /no such host|name resolution|could not resolve/i, label: 'DNS resolution failure' },
  { re: /permission denied|eacces/i, label: 'permission denied' },
  { re: /disk full|no space left|enospc/i, label: 'disk full' },
  { re: /too many open files|emfile/i, label: 'too many open files' },
  { re: /database is locked|sqlite_busy/i, label: 'database locked' },
  { re: /unauthorized|401/i, label: 'HTTP 401 unauthorized' },
  { re: /forbidden|403/i, label: 'HTTP 403 forbidden' },
  { re: /not found|404/i, label: 'HTTP 404 not found' },
  { re: /bad gateway|502/i, label: 'HTTP 502 bad gateway' },
  { re: /service unavailable|503/i, label: 'HTTP 503 unavailable' },
];

/**
 * Scan log lines for known error patterns. Returns a deduplicated list of
 * labels, most-frequent first.
 */
export function parseLogPatterns(lines: DiagnosisLogEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const msg = line.message || '';
    for (const { re, label } of LOG_PATTERNS) {
      if (re.test(msg)) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}

/**
 * Get cached logs for a container. Returns null if no valid entry.
 */
export function getCachedLogs(hostId: string, containerName: string): DiagnosisLogs {
  const key = cacheKey(hostId, containerName);
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    return {
      available: false,
      lines: [],
      errorPatterns: [],
      fetchedAt: null,
    };
  }
  return {
    available: true,
    lines: entry.lines,
    errorPatterns: entry.errorPatterns,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
  };
}

/**
 * Store logs in the cache. Extracts error patterns once at write time.
 */
export function setCachedLogs(hostId: string, containerName: string, lines: DiagnosisLogEntry[]): void {
  const key = cacheKey(hostId, containerName);
  const trimmed = lines.slice(-MAX_LINES_PER_CACHE_ENTRY);
  cache.set(key, {
    lines: trimmed,
    fetchedAt: Date.now(),
    errorPatterns: parseLogPatterns(trimmed),
  });
}

/**
 * Fire-and-forget log fetch. Never throws. Updates the cache on success.
 *
 * @param requestLogs — the MQTT log request function (from hub/src/mqtt.ts)
 */
export function fetchLogsBackground(
  hostId: string,
  containerName: string,
  containerId: string,
  requestLogs: (hostId: string, containerId: string, options: { lines: number; stream: string }) => Promise<DiagnosisLogEntry[]>,
): void {
  const key = cacheKey(hostId, containerName);
  if (pendingFetches.has(key)) return; // already in flight
  pendingFetches.add(key);

  (async () => {
    try {
      const lines = await requestLogs(hostId, containerId, { lines: 100, stream: 'both' });
      setCachedLogs(hostId, containerName, lines);
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

module.exports = {
  getCachedLogs,
  setCachedLogs,
  fetchLogsBackground,
  invalidateLogs,
  parseLogPatterns,
  _clearCache,
};
