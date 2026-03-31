/**
 * Read queries for insights data.
 */

function getBaselines(db, entityType, entityId) {
  return db.prepare(
    'SELECT metric, time_bucket, p50, p75, p90, p95, p99, min_val, max_val, sample_count, computed_at FROM baselines WHERE entity_type = ? AND entity_id = ?'
  ).all(entityType, entityId);
}

function getHostBaselines(db, hostId) {
  const hostBaselines = getBaselines(db, 'host', hostId);
  const containerBaselines = {};

  const containers = db.prepare(
    "SELECT DISTINCT entity_id FROM baselines WHERE entity_type = 'container' AND entity_id LIKE ?"
  ).all(`${hostId}/%`);

  for (const { entity_id } of containers) {
    containerBaselines[entity_id] = getBaselines(db, 'container', entity_id);
  }

  return { host: hostBaselines, containers: containerBaselines };
}

function getAllHealthScores(db) {
  return db.prepare('SELECT entity_type, entity_id, score, factors, computed_at FROM health_scores ORDER BY entity_type, entity_id').all();
}

function getHealthScore(db, entityType, entityId) {
  return db.prepare('SELECT entity_type, entity_id, score, factors, computed_at FROM health_scores WHERE entity_type = ? AND entity_id = ?').get(entityType, entityId) || null;
}

function getInsights(db, limit = 50) {
  return db.prepare(`
    SELECT * FROM insights
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      computed_at DESC
    LIMIT ?
  `).all(limit);
}

function getEntityInsights(db, entityType, entityId) {
  return db.prepare(`
    SELECT * FROM insights WHERE entity_type = ? AND entity_id = ?
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
  `).all(entityType, entityId);
}

function getHostInsights(db, hostId) {
  return db.prepare(`
    SELECT * FROM insights WHERE (entity_type = 'host' AND entity_id = ?) OR (entity_type = 'container' AND entity_id LIKE ?)
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
  `).all(hostId, `${hostId}/%`);
}

module.exports = { getBaselines, getHostBaselines, getAllHealthScores, getHealthScore, getInsights, getEntityInsights, getHostInsights };
