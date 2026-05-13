import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');

export interface RespawnLoopGroup {
  containerId: string;
  argvHash: string;
  spawnCount: number;
  shortRatio: number;
  avgLifetimeMs: number;
}

export interface TopArgv {
  argvHash: string;
  comm: string | null;
  argv: string;            // truncated to ARGV_TRUNCATE_BYTES
  spawnCount: number;
  avgLifetimeMs: number;
}

export interface DetectorParams {
  windowMin: number;
  minSpawns: number;
  shortLifetimeMs: number;
  shortLifetimeRatio: number;
}

const ARGV_TRUNCATE_BYTES = 200;

interface GroupRow {
  container_id: string;
  argv_hash: string;
  spawn_count: number;
  short_ratio: number;
  avg_lifetime_ms: number;
}

function findActiveRespawnLoops(
  db: Database.Database,
  now: Date,
  params: DetectorParams,
): RespawnLoopGroup[] {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  try {
    const rows = db.prepare(`
      WITH recent AS (
        SELECT container_id, argv_hash, lifetime_ms
          FROM process_events
         WHERE container_id IS NOT NULL
           AND started_at >= datetime(?, '-' || ? || ' minutes')
           AND exited_at IS NOT NULL
           AND lifetime_ms IS NOT NULL
      )
      SELECT container_id,
             argv_hash,
             COUNT(*) AS spawn_count,
             AVG(CASE WHEN lifetime_ms < ? THEN 1.0 ELSE 0.0 END) AS short_ratio,
             AVG(lifetime_ms) AS avg_lifetime_ms
        FROM recent
       GROUP BY container_id, argv_hash
      HAVING spawn_count >= ? AND short_ratio >= ?
    `).all(
      nowSql,
      params.windowMin,
      params.shortLifetimeMs,
      params.minSpawns,
      params.shortLifetimeRatio,
    ) as GroupRow[];

    return rows.map(r => ({
      containerId: r.container_id,
      argvHash: r.argv_hash,
      spawnCount: r.spawn_count,
      shortRatio: r.short_ratio,
      avgLifetimeMs: r.avg_lifetime_ms,
    }));
  } catch (err) {
    logger.warn('respawn-loop', `findActiveRespawnLoops query failed: ${(err as Error).message}`);
    return [];
  }
}

interface TopArgvRow {
  argv_hash: string;
  argv: string | null;
  comm: string | null;
  spawn_count: number;
  avg_lifetime_ms: number;
}

function fetchTopArgvs(
  db: Database.Database,
  containerId: string,
  now: Date,
  windowMin: number,
  limit: number = 5,
): TopArgv[] {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT pe.argv_hash,
           ad.argv,
           ad.comm,
           COUNT(*) AS spawn_count,
           AVG(pe.lifetime_ms) AS avg_lifetime_ms
      FROM process_events pe
      LEFT JOIN argv_dictionary ad ON ad.argv_hash = pe.argv_hash
     WHERE pe.container_id = ?
       AND pe.started_at >= datetime(?, '-' || ? || ' minutes')
     GROUP BY pe.argv_hash
     ORDER BY spawn_count DESC
     LIMIT ?
  `).all(containerId, nowSql, windowMin, limit) as TopArgvRow[];

  return rows.map(r => ({
    argvHash: r.argv_hash,
    comm: r.comm,
    argv: (r.argv ?? '').slice(0, ARGV_TRUNCATE_BYTES),
    spawnCount: r.spawn_count,
    avgLifetimeMs: r.avg_lifetime_ms ?? 0,
  }));
}

module.exports = { findActiveRespawnLoops, fetchTopArgvs };
