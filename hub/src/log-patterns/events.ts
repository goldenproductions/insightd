import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');
import type { MatchEvent, Registry } from './types';

function recordMatch(db: Database.Database, ev: MatchEvent, _registry: Registry): void {
  try {
    db.prepare(`
      INSERT INTO log_pattern_events
        (host_id, container_name, image, pattern_id, matched_line,
         context_before, context_after, captures, line_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, container_name, pattern_id, line_hash)
      DO UPDATE SET
        occurrences = occurrences + 1,
        last_seen_at = datetime('now'),
        captures = excluded.captures
    `).run(
      ev.hostId,
      ev.containerName,
      ev.image,
      ev.patternId,
      ev.matchedLine,
      JSON.stringify(ev.contextBefore ?? []),
      JSON.stringify(ev.contextAfter ?? []),
      JSON.stringify(ev.captures ?? {}),
      ev.lineHash,
    );
  } catch (err) {
    logger.warn('log-patterns', `recordMatch failed for pattern ${ev.patternId}: ${(err as Error).message}`);
  }
}

interface RecentRow {
  id: number;
  host_id: string;
  container_name: string;
  pattern_id: string;
  matched_line: string;
  fired_at: string;
  last_seen_at: string;
  occurrences: number;
  context_before: string | null;
  context_after: string | null;
  captures: string | null;
}

function findRecent(
  db: Database.Database,
  hostId: string,
  containerName: string,
  sinceRelative: string,
  patternIds?: string[],
): RecentRow[] {
  if (patternIds && patternIds.length > 0) {
    const placeholders = patternIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT id, host_id, container_name, pattern_id, matched_line, fired_at, last_seen_at, occurrences, context_before, context_after, captures
        FROM log_pattern_events
       WHERE host_id = ? AND container_name = ?
         AND fired_at >= datetime('now', ?)
         AND pattern_id IN (${placeholders})
       ORDER BY fired_at DESC
    `).all(hostId, containerName, sinceRelative, ...patternIds) as RecentRow[];
  }
  return db.prepare(`
    SELECT id, host_id, container_name, pattern_id, matched_line, fired_at, last_seen_at, occurrences, context_before, context_after, captures
      FROM log_pattern_events
     WHERE host_id = ? AND container_name = ?
       AND fired_at >= datetime('now', ?)
     ORDER BY fired_at DESC
  `).all(hostId, containerName, sinceRelative) as RecentRow[];
}

function findForAlertType(
  db: Database.Database,
  alertType: string,
  hostId: string,
  containerName: string,
  sinceRelative: string,
  registry: Registry,
): RecentRow[] {
  const matchingPatternIds = registry.all
    .filter(p => p.explainsAlert.includes(alertType))
    .map(p => p.id);
  if (matchingPatternIds.length === 0) return [];
  return findRecent(db, hostId, containerName, sinceRelative, matchingPatternIds);
}

module.exports = { recordMatch, findRecent, findForAlertType };
