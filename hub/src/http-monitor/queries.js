/**
 * Database queries for HTTP endpoint monitoring.
 */

function getEndpoints(db) {
  return db.prepare('SELECT * FROM http_endpoints ORDER BY name').all();
}

function getEndpoint(db, id) {
  return db.prepare('SELECT * FROM http_endpoints WHERE id = ?').get(id) || null;
}

function createEndpoint(db, data) {
  const result = db.prepare(`
    INSERT INTO http_endpoints (name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.url,
    data.method || 'GET',
    data.expectedStatus || 200,
    data.intervalSeconds || 60,
    data.timeoutMs || 10000,
    data.headers || null,
    data.enabled !== false ? 1 : 0
  );
  return { id: result.lastInsertRowid };
}

function updateEndpoint(db, id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.url !== undefined) { fields.push('url = ?'); values.push(data.url); }
  if (data.method !== undefined) { fields.push('method = ?'); values.push(data.method); }
  if (data.expectedStatus !== undefined) { fields.push('expected_status = ?'); values.push(data.expectedStatus); }
  if (data.intervalSeconds !== undefined) { fields.push('interval_seconds = ?'); values.push(data.intervalSeconds); }
  if (data.timeoutMs !== undefined) { fields.push('timeout_ms = ?'); values.push(data.timeoutMs); }
  if (data.headers !== undefined) { fields.push('headers = ?'); values.push(data.headers); }
  if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

  if (fields.length === 0) return { updated: false };

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = db.prepare(`UPDATE http_endpoints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { updated: result.changes > 0 };
}

function deleteEndpoint(db, id) {
  const result = db.prepare('DELETE FROM http_endpoints WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

function getChecks(db, endpointId, hours) {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT id, status_code, response_time_ms, is_up, error, checked_at
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= ${cutoff}
    ORDER BY checked_at DESC
  `).all(endpointId);
}

function insertCheck(db, endpointId, result) {
  db.prepare(`
    INSERT INTO http_checks (endpoint_id, status_code, response_time_ms, is_up, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(endpointId, result.statusCode ?? null, result.responseTimeMs ?? null, result.isUp ? 1 : 0, result.error ?? null);
}

function getLastCheck(db, endpointId) {
  return db.prepare(
    'SELECT checked_at FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1'
  ).get(endpointId) || null;
}

function getEndpointSummary(db, endpointId) {
  const uptime24h = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours')
  `).get(endpointId);

  const uptime7d = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-7 days')
  `).get(endpointId);

  const avgResponse = db.prepare(`
    SELECT AVG(response_time_ms) as avg_ms
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours') AND response_time_ms IS NOT NULL
  `).get(endpointId);

  const lastCheck = db.prepare(`
    SELECT status_code, response_time_ms, is_up, error, checked_at
    FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1
  `).get(endpointId);

  return {
    uptimePercent24h: uptime24h.total > 0 ? Math.round((uptime24h.up_count / uptime24h.total) * 1000) / 10 : null,
    uptimePercent7d: uptime7d.total > 0 ? Math.round((uptime7d.up_count / uptime7d.total) * 1000) / 10 : null,
    avgResponseMs: avgResponse.avg_ms ? Math.round(avgResponse.avg_ms) : null,
    lastCheck: lastCheck || null,
  };
}

function getEndpointsSummary(db) {
  const endpoints = getEndpoints(db);
  return endpoints.map(ep => {
    const lastCheck = db.prepare(`
      SELECT status_code, response_time_ms, is_up, error, checked_at
      FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1
    `).get(ep.id);

    const uptime24h = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
      FROM http_checks WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours')
    `).get(ep.id);

    const avgResponse = db.prepare(`
      SELECT AVG(response_time_ms) as avg_ms
      FROM http_checks WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours') AND response_time_ms IS NOT NULL
    `).get(ep.id);

    return {
      ...ep,
      lastCheck: lastCheck || null,
      uptimePercent24h: uptime24h.total > 0 ? Math.round((uptime24h.up_count / uptime24h.total) * 1000) / 10 : null,
      avgResponseMs: avgResponse.avg_ms ? Math.round(avgResponse.avg_ms) : null,
    };
  });
}

function getEndpointsForDigest(db) {
  const endpoints = getEndpoints(db);
  return endpoints.map(ep => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count,
        AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) as avg_ms
      FROM http_checks
      WHERE endpoint_id = ? AND checked_at >= datetime('now', '-7 days')
    `).get(ep.id);

    return {
      name: ep.name,
      url: ep.url,
      uptimePercent: stats.total > 0 ? Math.round((stats.up_count / stats.total) * 1000) / 10 : null,
      avgResponseMs: stats.avg_ms ? Math.round(stats.avg_ms) : null,
      totalChecks: stats.total,
    };
  });
}

function getLastNChecks(db, endpointId, n) {
  return db.prepare(`
    SELECT is_up FROM http_checks
    WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT ?
  `).all(endpointId, n);
}

module.exports = {
  getEndpoints, getEndpoint, createEndpoint, updateEndpoint, deleteEndpoint,
  getChecks, insertCheck, getLastCheck, getEndpointSummary, getEndpointsSummary,
  getEndpointsForDigest, getLastNChecks,
};
