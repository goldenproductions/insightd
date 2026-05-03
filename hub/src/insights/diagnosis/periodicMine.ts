/**
 * Periodic log-template mining over all live containers.
 *
 * Without this, Drain template mining only fires when a container transitions
 * to unhealthy or when a user opens the detail page of an unhealthy
 * container. Healthy containers never produce template baselines, and the
 * `template_burst_events` table stays empty for them — which means the
 * Explore-drawer "Log bursts" card and diagnoser log evidence have nothing to
 * show outside of incidents.
 *
 * Strategy: every 15 minutes, enumerate containers that snapshotted within
 * the last 10 minutes and trigger a fire-and-forget log fetch for each. The
 * existing `pendingFetches` set in `logCache.ts` deduplicates concurrent
 * requests, so re-running a mine cycle while a fetch is still in flight is
 * safe. Mining itself happens inside `setCachedLogs` once the agent replies.
 */

import type Database from 'better-sqlite3';
import logger = require('../../../../shared/utils/logger');

interface LiveContainerRow {
  host_id: string;
  container_name: string;
  container_id: string;
}

const LIVE_WINDOW_MINUTES = 10;
const LOG_LINES_PER_FETCH = 50;

/**
 * Fire log fetches for every container that has snapshotted within the last
 * `LIVE_WINDOW_MINUTES`. Each fetch is fire-and-forget; this function returns
 * the count of dispatched fetches without awaiting them.
 */
function runPeriodicMine(
  db: Database.Database,
  requestLogs: (hostId: string, containerId: string, options: { lines: number; stream: string }) => Promise<any[]>,
): number {
  const { fetchLogsBackground, resolveImageKey } = require('./logCache') as {
    fetchLogsBackground: (
      hostId: string,
      containerName: string,
      containerId: string,
      fetcher: (hostId: string, containerId: string, options: { lines: number; stream: string }) => Promise<any[]>,
      ctx?: { db: Database.Database; image: string | null },
    ) => void;
    resolveImageKey: (db: Database.Database, hostId: string, containerName: string) => string;
  };

  // Latest snapshot per (host, container) for live containers. We exclude
  // anything older than LIVE_WINDOW_MINUTES to avoid hammering MQTT for
  // hosts that have gone offline. The `containers` registry filters out
  // already-removed containers so a deleted container isn't re-fetched.
  const rows = db.prepare(`
    SELECT cs.host_id, cs.container_name, cs.container_id
    FROM container_snapshots cs
    INNER JOIN containers c
      ON c.host_id = cs.host_id AND c.container_name = cs.container_name
    INNER JOIN (
      SELECT host_id, container_name, MAX(collected_at) AS max_at
      FROM container_snapshots
      WHERE collected_at >= datetime('now', '-${LIVE_WINDOW_MINUTES} minutes')
      GROUP BY host_id, container_name
    ) latest
      ON cs.host_id = latest.host_id
      AND cs.container_name = latest.container_name
      AND cs.collected_at = latest.max_at
    WHERE c.removed_at IS NULL
  `).all() as LiveContainerRow[];

  if (rows.length === 0) return 0;

  let dispatched = 0;
  for (const row of rows) {
    if (!row.container_id) continue;
    const image = resolveImageKey(db, row.host_id, row.container_name);
    fetchLogsBackground(
      row.host_id,
      row.container_name,
      row.container_id,
      async (h: string, cid: string, _opts: any) => requestLogs(h, cid, { lines: LOG_LINES_PER_FETCH, stream: 'both' }),
      { db, image },
    );
    dispatched += 1;
  }

  logger.info('periodic-mine', `Dispatched ${dispatched} log fetch(es) across ${rows.length} live container(s)`);
  return dispatched;
}

module.exports = { runPeriodicMine };
