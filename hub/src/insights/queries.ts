import type Database from 'better-sqlite3';

/**
 * Read queries for insights data.
 */

interface BaselineRow {
  metric: string;
  time_bucket: string;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  min_val: number | null;
  max_val: number | null;
  sample_count: number;
  computed_at: string;
}

interface HealthScoreRow {
  entity_type: string;
  entity_id: string;
  score: number;
  factors: string;
  computed_at: string;
}

interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  metric: string | null;
  current_value: number | null;
  baseline_value: number | null;
  computed_at: string;
}

function getBaselines(db: Database.Database, entityType: string, entityId: string): BaselineRow[] {
  return db.prepare(
    'SELECT metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at FROM baselines WHERE entity_type = ? AND entity_id = ?'
  ).all(entityType, entityId) as BaselineRow[];
}

function getHostBaselines(db: Database.Database, hostId: string): { host: BaselineRow[]; containers: Record<string, BaselineRow[]> } {
  const hostBaselines = getBaselines(db, 'host', hostId);
  const containerBaselines: Record<string, BaselineRow[]> = {};

  const containers = db.prepare(
    "SELECT DISTINCT entity_id FROM baselines WHERE entity_type = 'container' AND entity_id LIKE ?"
  ).all(`${hostId}/%`) as { entity_id: string }[];

  for (const { entity_id } of containers) {
    containerBaselines[entity_id] = getBaselines(db, 'container', entity_id);
  }

  return { host: hostBaselines, containers: containerBaselines };
}

function getAllHealthScores(db: Database.Database): HealthScoreRow[] {
  return db.prepare('SELECT entity_type, entity_id, score, factors, computed_at FROM health_scores ORDER BY entity_type, entity_id').all() as HealthScoreRow[];
}

function getHealthScore(db: Database.Database, entityType: string, entityId: string): HealthScoreRow | null {
  return db.prepare('SELECT entity_type, entity_id, score, factors, computed_at FROM health_scores WHERE entity_type = ? AND entity_id = ?').get(entityType, entityId) as HealthScoreRow | undefined || null;
}

function getInsights(db: Database.Database, limit: number = 50): InsightRow[] {
  return db.prepare(`
    SELECT * FROM insights
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      computed_at DESC
    LIMIT ?
  `).all(limit) as InsightRow[];
}

function getEntityInsights(db: Database.Database, entityType: string, entityId: string): InsightRow[] {
  return db.prepare(`
    SELECT * FROM insights WHERE entity_type = ? AND entity_id = ?
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
  `).all(entityType, entityId) as InsightRow[];
}

function getHostInsights(db: Database.Database, hostId: string): InsightRow[] {
  return db.prepare(`
    SELECT * FROM insights WHERE (entity_type = 'host' AND entity_id = ?) OR (entity_type = 'container' AND entity_id LIKE ?)
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
  `).all(hostId, `${hostId}/%`) as InsightRow[];
}

module.exports = { getBaselines, getHostBaselines, getAllHealthScores, getHealthScore, getInsights, getEntityInsights, getHostInsights };
