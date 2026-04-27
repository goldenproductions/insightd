import type Database from 'better-sqlite3';

/**
 * Database queries for HTTP endpoint monitoring.
 */

interface HttpEndpoint {
  id: number;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  headers: string | null;
  enabled: number;
  tls_expires_at: string | null;
  tls_issuer: string | null;
  tls_subject_alt_names: string | null;
  tls_last_checked_at: string | null;
  tls_error: string | null;
  created_at: string;
  updated_at: string;
}

interface HttpCheck {
  id: number;
  status_code: number | null;
  response_time_ms: number | null;
  is_up: number;
  error: string | null;
  checked_at: string;
}

interface CheckResult {
  statusCode: number | null;
  responseTimeMs: number | null;
  isUp: boolean;
  error: string | null;
}

interface EndpointData {
  name: string;
  url: string;
  method?: string;
  expectedStatus?: number;
  intervalSeconds?: number;
  timeoutMs?: number;
  headers?: string | null;
  enabled?: boolean;
}

interface UptimeRow {
  total: number;
  up_count: number;
}

interface AvgRow {
  avg_ms: number | null;
}

interface EndpointSummary {
  uptimePercent24h: number | null;
  uptimePercent7d: number | null;
  avgResponseMs: number | null;
  lastCheck: HttpCheck | null;
}

interface EndpointDigest {
  name: string;
  url: string;
  uptimePercent: number | null;
  avgResponseMs: number | null;
  totalChecks: number;
}

interface DigestStatsRow {
  total: number;
  up_count: number;
  avg_ms: number | null;
}

function getEndpoints(db: Database.Database): HttpEndpoint[] {
  return db.prepare('SELECT * FROM http_endpoints ORDER BY name').all() as HttpEndpoint[];
}

function getEndpoint(db: Database.Database, id: number): HttpEndpoint | null {
  return db.prepare('SELECT * FROM http_endpoints WHERE id = ?').get(id) as HttpEndpoint | undefined || null;
}

function createEndpoint(db: Database.Database, data: EndpointData): { id: number | bigint } {
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

function updateEndpoint(db: Database.Database, id: number, data: Partial<EndpointData>): { updated: boolean } {
  const fields: string[] = [];
  const values: any[] = [];

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

function deleteEndpoint(db: Database.Database, id: number): { deleted: boolean } {
  const result = db.prepare('DELETE FROM http_endpoints WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

function getChecks(db: Database.Database, endpointId: number, hours: number): HttpCheck[] {
  const cutoff = `datetime('now', '-${Math.floor(hours)} hours')`;
  return db.prepare(`
    SELECT id, status_code, response_time_ms, is_up, error, checked_at
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= ${cutoff}
    ORDER BY checked_at DESC
  `).all(endpointId) as HttpCheck[];
}

function insertCheck(db: Database.Database, endpointId: number, result: CheckResult): void {
  db.prepare(`
    INSERT INTO http_checks (endpoint_id, status_code, response_time_ms, is_up, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(endpointId, result.statusCode ?? null, result.responseTimeMs ?? null, result.isUp ? 1 : 0, result.error ?? null);
}

function getLastCheck(db: Database.Database, endpointId: number): { checked_at: string } | null {
  return db.prepare(
    'SELECT checked_at FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1'
  ).get(endpointId) as { checked_at: string } | undefined || null;
}

function getEndpointSummary(db: Database.Database, endpointId: number): EndpointSummary {
  const uptime24h = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours')
  `).get(endpointId) as UptimeRow;

  const uptime7d = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-7 days')
  `).get(endpointId) as UptimeRow;

  const avgResponse = db.prepare(`
    SELECT AVG(response_time_ms) as avg_ms
    FROM http_checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours') AND response_time_ms IS NOT NULL
  `).get(endpointId) as AvgRow;

  const lastCheck = db.prepare(`
    SELECT status_code, response_time_ms, is_up, error, checked_at
    FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1
  `).get(endpointId) as HttpCheck | undefined;

  return {
    uptimePercent24h: uptime24h.total > 0 ? Math.round((uptime24h.up_count / uptime24h.total) * 1000) / 10 : null,
    uptimePercent7d: uptime7d.total > 0 ? Math.round((uptime7d.up_count / uptime7d.total) * 1000) / 10 : null,
    avgResponseMs: avgResponse.avg_ms ? Math.round(avgResponse.avg_ms) : null,
    lastCheck: lastCheck || null,
  };
}

function getEndpointsSummary(db: Database.Database): Array<HttpEndpoint & { lastCheck: HttpCheck | null; uptimePercent24h: number | null; avgResponseMs: number | null; recentChecks: { is_up: number; response_time_ms: number | null }[] }> {
  const endpoints = getEndpoints(db);
  return endpoints.map(ep => {
    const lastCheck = db.prepare(`
      SELECT status_code, response_time_ms, is_up, error, checked_at
      FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1
    `).get(ep.id) as HttpCheck | undefined;

    const uptime24h = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count
      FROM http_checks WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours')
    `).get(ep.id) as UptimeRow;

    const avgResponse = db.prepare(`
      SELECT AVG(response_time_ms) as avg_ms
      FROM http_checks WHERE endpoint_id = ? AND checked_at >= datetime('now', '-24 hours') AND response_time_ms IS NOT NULL
    `).get(ep.id) as AvgRow;

    // Newest-first from SQL → reverse so the sparkline reads left-to-right as old-to-new.
    const recent = db.prepare(`
      SELECT is_up, response_time_ms
      FROM http_checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 30
    `).all(ep.id) as { is_up: number; response_time_ms: number | null }[];

    return {
      ...ep,
      lastCheck: lastCheck || null,
      uptimePercent24h: uptime24h.total > 0 ? Math.round((uptime24h.up_count / uptime24h.total) * 1000) / 10 : null,
      avgResponseMs: avgResponse.avg_ms ? Math.round(avgResponse.avg_ms) : null,
      recentChecks: recent.reverse(),
    };
  });
}

function getEndpointsForDigest(db: Database.Database): EndpointDigest[] {
  const endpoints = getEndpoints(db);
  return endpoints.map(ep => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as up_count,
        AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END) as avg_ms
      FROM http_checks
      WHERE endpoint_id = ? AND checked_at >= datetime('now', '-7 days')
    `).get(ep.id) as DigestStatsRow;

    return {
      name: ep.name,
      url: ep.url,
      uptimePercent: stats.total > 0 ? Math.round((stats.up_count / stats.total) * 1000) / 10 : null,
      avgResponseMs: stats.avg_ms ? Math.round(stats.avg_ms) : null,
      totalChecks: stats.total,
    };
  });
}

// ---- Ingress auto-discovery ----

interface IngressRow {
  id: number;
  cluster_id: string;
  namespace: string;
  name: string;
  ingress_class: string | null;
  hosts: string;
  paths: string;
  tls_hosts: string | null;
  external_ip: string | null;
  created_at: string | null;
  observed_at: string;
}

interface DiscoveredIngress {
  id: number;
  clusterId: string;
  namespace: string;
  name: string;
  ingressClass: string | null;
  hosts: string[];
  paths: Array<{
    host: string;
    path: string;
    pathType: string | null;
    serviceName: string | null;
    servicePort: number | string | null;
  }>;
  tlsHosts: string[];
  externalIp: string | null;
  createdAt: string | null;
  observedAt: string;
  defaultUrl: string;
  defaultName: string;
}

function defaultUrlFor(host: string, tlsHosts: string[], firstNonRootPath: string | null): string {
  const scheme = tlsHosts.includes(host) ? 'https' : 'http';
  if (firstNonRootPath && firstNonRootPath !== '/') return `${scheme}://${host}${firstNonRootPath}`;
  return `${scheme}://${host}`;
}

function defaultNameFor(namespace: string, host: string): string {
  return `${namespace}/${host}`;
}

function parseJsonArray<T>(s: string | null | undefined, fallback: T[]): T[] {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch { return fallback; }
}

/**
 * Returns the list of ingresses the user hasn't decided about yet — present
 * in the cluster (`removed_at IS NULL`), not yet dismissed, not yet promoted
 * to a monitored endpoint. Once a row is monitored or dismissed it drops off
 * the list; the card on the Endpoints page hides itself entirely when this
 * list is empty.
 */
function getDiscoveredIngresses(db: Database.Database, clusterId?: string): DiscoveredIngress[] {
  const rows = db.prepare(`
    SELECT i.id, i.cluster_id, i.namespace, i.name, i.ingress_class,
           i.hosts, i.paths, i.tls_hosts, i.external_ip, i.created_at, i.observed_at
    FROM k8s_ingresses i
    LEFT JOIN http_endpoints e ON e.source_ingress_id = i.id
    WHERE i.removed_at IS NULL
      AND i.dismissed_at IS NULL
      AND e.id IS NULL
    ${clusterId ? 'AND i.cluster_id = ?' : ''}
    ORDER BY i.namespace, i.name
  `).all(...(clusterId ? [clusterId] : [])) as IngressRow[];

  return rows.map(r => {
    const hosts = parseJsonArray<string>(r.hosts, []);
    const paths = parseJsonArray<{ host: string; path: string; pathType: string | null; serviceName: string | null; servicePort: number | string | null }>(r.paths, []);
    const tlsHosts = parseJsonArray<string>(r.tls_hosts, []);
    const primary = hosts[0] ?? '';
    const firstNonRoot = paths.find(p => p.host === primary && p.path && p.path !== '/')?.path ?? null;
    return {
      id: r.id,
      clusterId: r.cluster_id,
      namespace: r.namespace,
      name: r.name,
      ingressClass: r.ingress_class,
      hosts,
      paths,
      tlsHosts,
      externalIp: r.external_ip,
      createdAt: r.created_at,
      observedAt: r.observed_at,
      defaultUrl: primary ? defaultUrlFor(primary, tlsHosts, firstNonRoot) : '',
      defaultName: primary ? defaultNameFor(r.namespace, primary) : `${r.namespace}/${r.name}`,
    };
  });
}

/**
 * Mark an ingress as dismissed so it stops showing up in the discovered
 * list. Idempotent. Reversible via undismissIngress. Dismissal is sticky
 * across publisher cycles — the ingress reappears only if it's deleted in
 * the cluster (removed_at stamped) and recreated, which clears the row's
 * dismissed_at on a separate code path? No — re-creation reuses the same
 * id, so the dismissal persists. Users undo via the API.
 */
function dismissIngress(db: Database.Database, ingressId: number): { dismissed: boolean } {
  const r = db.prepare(`UPDATE k8s_ingresses SET dismissed_at = datetime('now') WHERE id = ? AND removed_at IS NULL`).run(ingressId);
  return { dismissed: r.changes > 0 };
}

function undismissIngress(db: Database.Database, ingressId: number): { undismissed: boolean } {
  const r = db.prepare(`UPDATE k8s_ingresses SET dismissed_at = NULL WHERE id = ?`).run(ingressId);
  return { undismissed: r.changes > 0 };
}

interface CreateFromIngressResult {
  id: number | bigint;
  url: string;
  name: string;
}

/**
 * Promote a discovered ingress to a polling http_endpoint. Idempotent at the
 * "already monitored" level — throws { code: 'ALREADY_MONITORED', endpointId }
 * if a row already exists with this `source_ingress_id`. Name collisions get
 * a -2/-3 suffix.
 */
function createEndpointFromIngress(db: Database.Database, ingressId: number): CreateFromIngressResult {
  const row = db.prepare('SELECT * FROM k8s_ingresses WHERE id = ? AND removed_at IS NULL').get(ingressId) as IngressRow | undefined;
  if (!row) {
    const err = new Error('Ingress not found') as Error & { code?: string };
    err.code = 'NOT_FOUND';
    throw err;
  }
  const existing = db.prepare('SELECT id FROM http_endpoints WHERE source_ingress_id = ?').get(ingressId) as { id: number } | undefined;
  if (existing) {
    const err = new Error('Ingress already monitored') as Error & { code?: string; endpointId?: number };
    err.code = 'ALREADY_MONITORED';
    err.endpointId = existing.id;
    throw err;
  }

  const hosts = parseJsonArray<string>(row.hosts, []);
  const paths = parseJsonArray<{ host: string; path: string; pathType: string | null; serviceName: string | null; servicePort: number | string | null }>(row.paths, []);
  const tlsHosts = parseJsonArray<string>(row.tls_hosts, []);
  const primary = hosts[0];
  if (!primary) {
    const err = new Error('Ingress has no host — cannot derive URL') as Error & { code?: string };
    err.code = 'NO_HOST';
    throw err;
  }
  const firstNonRoot = paths.find(p => p.host === primary && p.path && p.path !== '/')?.path ?? null;
  const url = defaultUrlFor(primary, tlsHosts, firstNonRoot);
  const baseName = defaultNameFor(row.namespace, primary);

  // Resolve name collisions: append -2, -3, ...
  let name = baseName;
  let suffix = 2;
  const nameExists = db.prepare('SELECT 1 FROM http_endpoints WHERE name = ?');
  while (nameExists.get(name)) {
    name = `${baseName}-${suffix++}`;
  }

  const result = db.prepare(`
    INSERT INTO http_endpoints
      (name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled, source_ingress_id)
    VALUES (?, ?, 'GET', 200, 60, 10000, NULL, 1, ?)
  `).run(name, url, ingressId);
  return { id: result.lastInsertRowid, url, name };
}

function getLastNChecks(db: Database.Database, endpointId: number, n: number): { is_up: number }[] {
  return db.prepare(`
    SELECT is_up FROM http_checks
    WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT ?
  `).all(endpointId, n) as { is_up: number }[];
}

module.exports = {
  getEndpoints, getEndpoint, createEndpoint, updateEndpoint, deleteEndpoint,
  getChecks, insertCheck, getLastCheck, getEndpointSummary, getEndpointsSummary,
  getEndpointsForDigest, getLastNChecks,
  getDiscoveredIngresses, createEndpointFromIngress, dismissIngress, undismissIngress,
};
