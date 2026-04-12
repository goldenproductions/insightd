/**
 * Sticky findings cache.
 *
 * The diagnosis engine runs on every container-detail view. On each run it
 * rebuilds the evidence list from live context — which means small metric
 * drifts or log-cache cycling can rewrite the reasoning text even when the
 * underlying diagnosis hasn't changed. Users see the same container with
 * subtly different evidence every refresh and wonder what's happening.
 *
 * This module wraps the diagnoser output in a tiny in-memory cache keyed by
 * (hostId, containerName, diagnoser). As long as the new run produces the
 * same conclusion and severity as the cached one, we return the cached
 * finding unchanged — stable evidence, stable suggested action, stable
 * `diagnosedAt`. The moment the conclusion or severity shifts, we replace
 * the cache entry with the new finding and stamp a fresh `diagnosedAt`.
 *
 * The cache is process-local; a hub restart flushes it, and the next view
 * stamps fresh findings. That's fine — restart is a natural checkpoint.
 */

import type { Finding } from './types';

interface CachedEntry {
  finding: Finding;
  diagnosedAt: number; // epoch ms
}

const cache = new Map<string, CachedEntry>();

function cacheKey(hostId: string, containerName: string, diagnoser: string): string {
  return `${hostId}\u0000${containerName}\u0000${diagnoser}`;
}

/**
 * Wrap a list of freshly-produced findings in sticky behavior. For each
 * incoming finding, either return the cached version (if the conclusion +
 * severity match) or replace the cache entry and return the new one.
 */
export function stickyFindings(
  hostId: string,
  containerName: string,
  fresh: Finding[],
  nowMs: number = Date.now(),
): Finding[] {
  const result: Finding[] = [];
  for (const next of fresh) {
    const key = cacheKey(hostId, containerName, next.diagnoser);
    const cached = cache.get(key);

    if (
      cached &&
      cached.finding.conclusion === next.conclusion &&
      cached.finding.severity === next.severity
    ) {
      // Stable: hand back the cached finding so evidence + action text
      // don't shimmer between views.
      result.push({
        ...cached.finding,
        diagnosedAt: new Date(cached.diagnosedAt).toISOString(),
      });
      continue;
    }

    // Either no cache yet or the diagnosis materially changed — stamp fresh.
    const stamped: Finding = {
      ...next,
      diagnosedAt: new Date(nowMs).toISOString(),
    };
    cache.set(key, { finding: stamped, diagnosedAt: nowMs });
    result.push(stamped);
  }
  return result;
}

/** Test-only helper: reset the sticky cache between test cases. */
export function _clearStickyCache(): void {
  cache.clear();
}

module.exports = { stickyFindings, _clearStickyCache };
