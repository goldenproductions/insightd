import type { IncomingMessage, ServerResponse } from 'http';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';

const queries = require('./queries');
const { isAuthEnabled, authenticate, requireAuth, isSetupComplete, createApiKey, revokeApiKey, getApiKeys } = require('./auth') as {
  isAuthEnabled: () => boolean;
  authenticate: (password: string, ip?: string) => string | null;
  requireAuth: (req: IncomingMessage) => boolean;
  isSetupComplete: () => boolean;
  createApiKey: (db: Database.Database, name: string) => { key: string; prefix: string };
  revokeApiKey: (db: Database.Database, id: number) => void;
  getApiKeys: (db: Database.Database) => any[];
};
const { getSettings, putSettings } = require('../db/settings') as {
  getSettings: (db: Database.Database) => Array<{ category: string; [key: string]: any }>;
  putSettings: (db: Database.Database, body: any) => any;
};

type HandlerReq = IncomingMessage & { body?: any; url: string };
type HandlerCtx = {
  docker?: Dockerode;
  requestLogs?: Function;
  requestUpdate?: Function;
  requestAction?: Function;
};

function readBody(req: IncomingMessage, maxBytes: number = 65536): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function handleHealth(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const health = queries.getHealth(db);
  health.authEnabled = isAuthEnabled();
  health.mode = config.mqttUrl ? 'hub' : 'standalone';
  health.setupComplete = isSetupComplete();
  return health;
}

function handleSetupStatus(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any): any {
  return {
    setupComplete: isSetupComplete(),
    mode: config.mqttUrl ? 'hub' : 'standalone',
    authEnabled: isAuthEnabled(),
  };
}

async function handleSetupPassword(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (isSetupComplete()) { res.statusCode = 403; return { error: 'Setup already complete' }; }
  const body = await readBody(req);
  if (!body.password || body.password.length < 4) { res.statusCode = 400; return { error: 'Password must be at least 4 characters' }; }
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin.password', ?, datetime('now'))").run(body.password);
  return { saved: true };
}

function handleSetupComplete(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  if (isSetupComplete()) { res.statusCode = 403; return { error: 'Setup already complete' }; }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_complete', 'true')").run();
  return { complete: true };
}

function handleHosts(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getHosts(db, threshold);
}

async function handleDeleteHost(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const hostId = decodeURIComponent(params.hostId);
  const host = db.prepare('SELECT host_id FROM hosts WHERE host_id = ?').get(hostId) as { host_id: string } | undefined;
  if (!host) { res.statusCode = 404; return { error: 'Host not found' }; }

  db.prepare('DELETE FROM container_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM host_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM disk_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM update_checks WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM alert_state WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM service_group_members WHERE host_id = ?').run(hostId);
  db.prepare("DELETE FROM baselines WHERE entity_id = ? OR entity_id LIKE ?").run(hostId, `${hostId}/%`);
  db.prepare("DELETE FROM health_scores WHERE entity_id = ? OR entity_id LIKE ?").run(hostId, `${hostId}/%`);
  db.prepare('DELETE FROM hosts WHERE host_id = ?').run(hostId);

  return { deleted: true, hostId };
}

async function handleDeleteContainer(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const hostId = decodeURIComponent(params.hostId);
  const containerName = decodeURIComponent(params.containerName);

  // Best-effort Docker remove
  try {
    if (ctx.docker) {
      const containers = await ctx.docker.listContainers({ all: true });
      const match = containers.find((c: Dockerode.ContainerInfo) => c.Names.some(n => n === `/${containerName}` || n === containerName));
      if (match) {
        if (match.State === 'running') {
          res.statusCode = 409;
          return { error: `Container "${containerName}" is running. Stop it before removing.` };
        }
        if (match.Labels && match.Labels['insightd.internal'] === 'true') {
          res.statusCode = 403;
          return { error: 'Cannot remove internal insightd containers' };
        }
        await ctx.docker.getContainer(match.Id).remove();
      }
    } else if (ctx.requestAction) {
      try {
        const result = await ctx.requestAction(hostId, containerName, 'remove') as { status: string; error?: string };
        if (result.status === 'failed' && result.error) {
          if (result.error.includes('running')) {
            res.statusCode = 409;
            return { error: result.error };
          }
          // "not found" is fine — container already gone
        }
      } catch {
        // Timeout or MQTT error — proceed to DB cleanup anyway
      }
    }
  } catch {
    // Docker remove failed (already gone, etc.) — proceed to DB cleanup
  }

  // DB cleanup — remove all container records
  const entityId = `${hostId}/${containerName}`;
  const cleanup = db.transaction(() => {
    db.prepare('DELETE FROM container_snapshots WHERE host_id = ? AND container_name = ?').run(hostId, containerName);
    db.prepare('DELETE FROM update_checks WHERE host_id = ? AND container_name = ?').run(hostId, containerName);
    db.prepare('DELETE FROM alert_state WHERE host_id = ? AND target = ?').run(hostId, containerName);
    db.prepare('DELETE FROM service_group_members WHERE host_id = ? AND container_name = ?').run(hostId, containerName);
    db.prepare("DELETE FROM baselines WHERE entity_type = 'container' AND entity_id = ?").run(entityId);
    db.prepare("DELETE FROM health_scores WHERE entity_type = 'container' AND entity_id = ?").run(entityId);
  });
  cleanup();

  return { deleted: true, hostId, containerName };
}

function handleHostDetail(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  const threshold = config.collectIntervalMinutes * 2;
  const detail = queries.getHostDetail(db, params.hostId, threshold, showInternal);
  if (!detail) {
    res.statusCode = 404;
    return { error: 'Host not found' };
  }
  return detail;
}

function handleHostContainers(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  return queries.getLatestContainers(db, params.hostId, showInternal);
}

function handleHostDisk(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  return queries.getLatestDisk(db, params.hostId);
}

function handleDashboard(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getDashboard(db, threshold, showInternal);
}

function handleAlerts(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const activeOnly = url.searchParams.get('active') !== 'false';
  return queries.getAlerts(db, activeOnly);
}

function handleContainerDetail(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = Math.max(1, Math.min(720, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
  const latest = queries.getLatestContainers(db, params.hostId)
    .find((c: any) => c.container_name === params.containerName);
  if (!latest) {
    res.statusCode = 404;
    return { error: 'Container not found' };
  }
  return {
    ...latest,
    host_id: params.hostId,
    history: queries.getContainerHistory(db, params.hostId, params.containerName, hours),
    alerts: queries.getContainerAlerts(db, params.hostId, params.containerName),
  };
}

async function handleContainerLogs(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || String(config.logLines || 100), 10) || 100, 1), 1000);
  const stream = url.searchParams.get('stream') || 'both';
  if (!['stdout', 'stderr', 'both'].includes(stream)) {
    res.statusCode = 400;
    return { error: 'stream must be stdout, stderr, or both' };
  }

  const containerId = queries.getContainerId(db, params.hostId, params.containerName);
  if (!containerId) {
    res.statusCode = 404;
    return { error: 'Container not found' };
  }

  try {
    let logs: any;
    if (ctx.docker) {
      // Standalone mode — direct Docker access
      const { fetchContainerLogs } = require('../../../shared/utils/docker-logs');
      logs = await fetchContainerLogs(ctx.docker, containerId, { lines, stream });
    } else if (ctx.requestLogs) {
      // Hub mode — MQTT request/reply
      logs = await ctx.requestLogs(params.hostId, containerId, {
        lines,
        stream,
        timeoutMs: config.logTimeoutMs || 15000,
      });
    } else {
      res.statusCode = 501;
      return { error: 'Log fetching not available in this mode' };
    }
    return { container: params.containerName, logs };
  } catch (err) {
    res.statusCode = 504;
    return { error: (err as Error).message };
  }
}

function handleHostMetrics(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = Math.max(1, Math.min(720, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
  return queries.getHostMetricsHistory(db, params.hostId, hours);
}

async function handleLogin(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any): Promise<any> {
  const body = await readBody(req);
  const ip = req.socket.remoteAddress;
  const token = authenticate(body.password || '', ip);
  if (!token) {
    res.statusCode = 401;
    return { error: 'Invalid password' };
  }
  return { token };
}

function handleGetSettings(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const settings = getSettings(db);
  // Group by category
  const grouped: Record<string, any[]> = {};
  for (const s of settings) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }
  return { categories: grouped };
}

async function handlePutSettings(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const body = await readBody(req);
  return putSettings(db, body);
}

function handleAgentSetup(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any): any {
  const host = config.externalHost || (req.headers.host || 'localhost').replace(/:\d+$/, '');
  return {
    mqttUrl: `mqtt://${host}:1883`,
    mqttUser: config.mqttUser || '',
    mqttPass: config.mqttPass || '',
    image: 'andreas404/insightd-agent:latest',
  };
}

function handleTimeline(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  return queries.getUptimeTimeline(db, params.hostId, days);
}

function handleRankings(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
  return queries.getResourceRankings(db, limit);
}

function handleTrends(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  return queries.getTrends(db, params.hostId);
}

function handleEvents(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  return queries.getEvents(db, params.hostId, days);
}

// --- HTTP Endpoint Monitoring ---

const endpointQueries = require('../http-monitor/queries');

function validateEndpointBody(body: any): string[] {
  const errors: string[] = [];
  if (!body.name || typeof body.name !== 'string' || body.name.length > 100) {
    errors.push('name is required (max 100 characters)');
  }
  if (!body.url || typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
    errors.push('url is required and must start with http:// or https://');
  }
  if (body.method && !['GET', 'HEAD'].includes(body.method)) {
    errors.push('method must be GET or HEAD');
  }
  if (body.expectedStatus !== undefined) {
    const s = parseInt(body.expectedStatus, 10);
    if (isNaN(s) || s < 100 || s > 599) errors.push('expectedStatus must be 100-599');
  }
  if (body.intervalSeconds !== undefined) {
    const i = parseInt(body.intervalSeconds, 10);
    if (isNaN(i) || i < 10 || i > 3600) errors.push('intervalSeconds must be 10-3600');
  }
  if (body.timeoutMs !== undefined) {
    const t = parseInt(body.timeoutMs, 10);
    if (isNaN(t) || t < 1000 || t > 30000) errors.push('timeoutMs must be 1000-30000');
  }
  if (body.headers !== undefined && body.headers !== null && body.headers !== '') {
    try { JSON.parse(body.headers); } catch { errors.push('headers must be valid JSON'); }
  }
  return errors;
}

function handleGetEndpoints(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  return endpointQueries.getEndpointsSummary(db);
}

async function handleCreateEndpoint(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const body = await readBody(req);
  const errors = validateEndpointBody(body);
  if (errors.length > 0) {
    res.statusCode = 400;
    return { error: errors.join('; ') };
  }
  const result = endpointQueries.createEndpoint(db, body);
  res.statusCode = 201;
  return result;
}

function handleGetEndpoint(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const endpoint = endpointQueries.getEndpoint(db, parseInt(params.endpointId, 10));
  if (!endpoint) {
    res.statusCode = 404;
    return { error: 'Endpoint not found' };
  }
  const summary = endpointQueries.getEndpointSummary(db, endpoint.id);
  return { ...endpoint, ...summary };
}

async function handleUpdateEndpoint(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const id = parseInt(params.endpointId, 10);
  const existing = endpointQueries.getEndpoint(db, id);
  if (!existing) {
    res.statusCode = 404;
    return { error: 'Endpoint not found' };
  }
  const body = await readBody(req);
  const errors = validateEndpointBody({ ...existing, name: existing.name, url: existing.url, ...body });
  if (errors.length > 0) {
    res.statusCode = 400;
    return { error: errors.join('; ') };
  }
  return endpointQueries.updateEndpoint(db, id, body);
}

async function handleDeleteEndpoint(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const id = parseInt(params.endpointId, 10);
  const result = endpointQueries.deleteEndpoint(db, id);
  if (!result.deleted) {
    res.statusCode = 404;
    return { error: 'Endpoint not found' };
  }
  return result;
}

function handleEndpointChecks(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const id = parseInt(params.endpointId, 10);
  const endpoint = endpointQueries.getEndpoint(db, id);
  if (!endpoint) {
    res.statusCode = 404;
    return { error: 'Endpoint not found' };
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = Math.max(1, Math.min(720, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
  return endpointQueries.getChecks(db, id, hours);
}

// --- Webhooks ---

const webhookQueries = require('../../../shared/webhooks/queries');
const { sendTestWebhook } = require('../../../shared/webhooks/sender') as { sendTestWebhook: (wh: any) => Promise<any> };

const VALID_WEBHOOK_TYPES = ['slack', 'discord', 'telegram', 'ntfy', 'generic'];

function validateWebhookBody(body: any): string[] {
  const errors: string[] = [];
  if (!body.name || typeof body.name !== 'string' || body.name.length > 100) {
    errors.push('name is required (max 100 chars)');
  }
  if (!body.type || !VALID_WEBHOOK_TYPES.includes(body.type)) {
    errors.push('type must be one of: ' + VALID_WEBHOOK_TYPES.join(', '));
  }
  if (body.type === 'telegram') {
    if (!body.url) errors.push('Bot token is required for Telegram');
    if (!body.secret) errors.push('Chat ID is required for Telegram');
  } else {
    if (!body.url || !/^https?:\/\//.test(body.url)) {
      errors.push('url must start with http:// or https://');
    }
  }
  return errors;
}

function handleGetWebhooks(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  return webhookQueries.getWebhooks(db);
}

async function handleCreateWebhook(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  const errors = validateWebhookBody(body);
  if (errors.length > 0) { res.statusCode = 400; return { error: errors.join('; ') }; }
  res.statusCode = 201;
  return webhookQueries.createWebhook(db, body);
}

function handleGetWebhook(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const wh = webhookQueries.getWebhook(db, parseInt(params.webhookId, 10));
  if (!wh) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return wh;
}

async function handleUpdateWebhook(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const existing = webhookQueries.getWebhook(db, id);
  if (!existing) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  const body = await readBody(req);
  return webhookQueries.updateWebhook(db, id, body);
}

async function handleDeleteWebhook(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const result = webhookQueries.deleteWebhook(db, id);
  if (!result.deleted) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return result;
}

async function handleTestWebhook(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const wh = webhookQueries.getWebhook(db, id);
  if (!wh) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return sendTestWebhook(wh);
}

async function handleTestWebhookUnsaved(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  const errors = validateWebhookBody(body);
  if (errors.length > 0) { res.statusCode = 400; return { error: errors.join('; ') }; }
  return sendTestWebhook(body);
}

// --- Service Groups ---

const groupQueries = require('./group-queries');

function handleGetGroups(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  return groupQueries.getGroups(db, showInternal);
}

async function handleCreateGroup(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  if (!body.name || typeof body.name !== 'string' || body.name.length > 100) {
    res.statusCode = 400; return { error: 'name is required (max 100 chars)' };
  }
  try {
    res.statusCode = 201;
    return groupQueries.createGroup(db, body);
  } catch {
    res.statusCode = 409; return { error: 'A group with this name already exists' };
  }
}

function handleGetGroup(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const detail = groupQueries.getGroupDetail(db, parseInt(params.groupId, 10));
  if (!detail) { res.statusCode = 404; return { error: 'Group not found' }; }
  return detail;
}

async function handleUpdateGroup(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.groupId, 10);
  if (!groupQueries.getGroup(db, id)) { res.statusCode = 404; return { error: 'Group not found' }; }
  const body = await readBody(req);
  return groupQueries.updateGroup(db, id, body);
}

async function handleDeleteGroup(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const result = groupQueries.deleteGroup(db, parseInt(params.groupId, 10));
  if (!result.deleted) { res.statusCode = 404; return { error: 'Group not found' }; }
  return result;
}

async function handleAddGroupMember(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const groupId = parseInt(params.groupId, 10);
  if (!groupQueries.getGroup(db, groupId)) { res.statusCode = 404; return { error: 'Group not found' }; }
  const body = await readBody(req);
  if (!body.hostId || !body.containerName) { res.statusCode = 400; return { error: 'hostId and containerName are required' }; }
  return groupQueries.addGroupMember(db, groupId, body.hostId, body.containerName);
}

async function handleRemoveGroupMember(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const groupId = parseInt(params.groupId, 10);
  const body = await readBody(req);
  if (!body.hostId || !body.containerName) { res.statusCode = 400; return { error: 'hostId and containerName are required' }; }
  return groupQueries.removeGroupMember(db, groupId, body.hostId, body.containerName);
}

// --- Insights ---

const insightQueries = require('../insights/queries');

function handleGetBaselines(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  return insightQueries.getBaselines(db, params.entityType, decodeURIComponent(params.entityId));
}

function handleGetAllHealthScores(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  return insightQueries.getAllHealthScores(db);
}

function handleGetHealthScore(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const score = insightQueries.getHealthScore(db, params.entityType, decodeURIComponent(params.entityId));
  if (!score) { res.statusCode = 404; return { error: 'No health score found' }; }
  score.factors = JSON.parse(score.factors);
  return score;
}

function handleGetInsights(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  return insightQueries.getInsights(db);
}

function handleGetHostInsights(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  return insightQueries.getHostInsights(db, params.hostId);
}

async function handleInsightFeedback(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  const body = req.body as { entity_type?: string; entity_id?: string; category?: string; metric?: string | null; helpful?: boolean };
  if (!body.entity_type || !body.entity_id || !body.category || body.helpful == null) {
    res.statusCode = 400;
    return { error: 'entity_type, entity_id, category, and helpful are required' };
  }
  db.prepare(`
    INSERT INTO insight_feedback (entity_type, entity_id, category, metric, helpful)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, category, metric) DO UPDATE SET helpful = ?, created_at = datetime('now')
  `).run(body.entity_type, body.entity_id, body.category, body.metric ?? null, body.helpful ? 1 : 0, body.helpful ? 1 : 0);
  return { ok: true };
}

function handleGetInsightFeedback(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  return db.prepare('SELECT entity_type, entity_id, category, metric, helpful, created_at FROM insight_feedback ORDER BY created_at DESC').all();
}

function handleImageUpdates(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  return queries.getAllImageUpdates(db);
}

// --- Version + Updates ---

function handleVersionCheck(req: HandlerReq, res: ServerResponse): any {
  const { getVersionInfo } = require('../version-check');
  return getVersionInfo();
}

async function handleUpdateAgent(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  if (!ctx.requestUpdate) { res.statusCode = 501; return { error: 'Update not available in standalone mode' }; }
  // Snooze alerts during update
  const { snoozeAlerts } = require('../alert-snooze');
  snoozeAlerts(10);
  const { getVersionInfo } = require('../version-check');
  const vi = getVersionInfo();
  const tag = vi.latestAgentVersion || vi.currentVersion;
  const image = `andreas404/insightd-agent:${tag}`;
  try {
    const result = await ctx.requestUpdate(params.hostId, 'agent', image);
    return result;
  } catch (err) {
    res.statusCode = 504;
    return { error: (err as Error).message };
  }
}

async function handleUpdateAllAgents(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  if (!ctx.requestUpdate) { res.statusCode = 501; return { error: 'Update not available in standalone mode' }; }
  const { snoozeAlerts } = require('../alert-snooze');
  snoozeAlerts(15);
  const hosts = queries.getHosts(db, config.collectIntervalMinutes * 2);
  const { getVersionInfo } = require('../version-check');
  const vi = getVersionInfo();
  const tag = vi.latestAgentVersion || vi.currentVersion;
  const image = `andreas404/insightd-agent:${tag}`;
  const results: any[] = [];
  for (const host of hosts) {
    try {
      const result = await ctx.requestUpdate(host.host_id, 'agent', image);
      results.push({ hostId: host.host_id, ...result });
    } catch (err) {
      results.push({ hostId: host.host_id, status: 'failed', error: (err as Error).message });
    }
  }
  return { results };
}

async function handleUpdateHub(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  if (!ctx.requestUpdate) { res.statusCode = 501; return { error: 'Update not available in standalone mode' }; }
  const { snoozeAlerts } = require('../alert-snooze');
  snoozeAlerts(10);
  // Find the agent on the same host as the hub
  const hubHostId = config.hostId || 'local';
  const hosts = queries.getHosts(db, config.collectIntervalMinutes * 2);
  const localAgent = hosts.find((h: any) => h.host_id === hubHostId && h.is_online);
  if (!localAgent) { res.statusCode = 400; return { error: `No online agent found on hub host (${hubHostId}). Ensure an agent is running on the same host.` }; }
  const { getVersionInfo } = require('../version-check');
  const vi = getVersionInfo();
  const tag = vi.latestHubVersion || vi.currentVersion;
  const image = `andreas404/insightd-hub:${tag}`;
  try {
    const result = await ctx.requestUpdate(localAgent.host_id, 'hub', image);
    return result;
  } catch (err) {
    res.statusCode = 504;
    return { error: (err as Error).message };
  }
}

function handleContainerAvailability(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  // Existence check uses raw DB lookup (not getLatestContainers, which filters
  // out stale containers — historical availability should still work even
  // for containers that have since been removed).
  const exists = db.prepare(
    'SELECT 1 FROM container_snapshots WHERE host_id = ? AND container_name = ? LIMIT 1'
  ).get(params.hostId, params.containerName);
  if (!exists) {
    res.statusCode = 404;
    return { error: 'Container not found' };
  }
  return queries.getContainerDowntime(db, params.hostId, params.containerName, days);
}

function handlePublicStatus(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any): any {
  // No auth — this is a public endpoint
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'statusPage.enabled'").get() as { value: string } | undefined;
  if (!enabled || enabled.value !== 'true') {
    res.statusCode = 404;
    return { error: 'Status page not enabled' };
  }

  const titleRow = db.prepare("SELECT value FROM settings WHERE key = 'statusPage.title'").get() as { value: string } | undefined;
  const title = titleRow?.value || 'System Status';

  // Service groups with members
  let groups: any[] = [];
  try {
    const groupQueries = require('./group-queries');
    groups = groupQueries.getGroups(db, false).map((g: any) => {
      const detail = groupQueries.getGroupDetail(db, g.id);
      return {
        id: g.id, name: g.name, icon: g.icon, color: g.color,
        running_count: g.running_count, member_count: g.member_count,
        members: (detail?.members || []).map((m: any) => ({
          container_name: m.container_name, host_id: m.host_id, status: m.status,
        })),
      };
    });
  } catch { /* no groups */ }

  // HTTP endpoints
  let endpoints: any[] = [];
  try {
    const httpQueries = require('../http-monitor/queries');
    const summaries = httpQueries.getEndpointsSummary(db);
    endpoints = summaries.map((e: any) => ({
      name: e.name, url: e.url,
      is_up: e.lastCheck ? e.lastCheck.is_up === 1 : null,
      uptimePercent24h: e.uptimePercent24h,
      avgResponseMs: e.avgResponseMs,
      lastCheckedAt: e.lastCheck?.checked_at || null,
    }));
  } catch { /* no endpoints */ }

  // Overall status
  const allContainersOk = groups.every((g: any) => g.running_count === g.member_count);
  const allEndpointsOk = endpoints.every((e: any) => e.is_up !== false);
  const anyData = groups.length > 0 || endpoints.length > 0;
  const overallStatus = !anyData ? 'operational' : (allContainersOk && allEndpointsOk) ? 'operational' : 'degraded';

  return { title, overallStatus, groups, endpoints, updatedAt: new Date().toISOString() };
}

async function handleContainerAction(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>, ctx: HandlerCtx): Promise<any> {
  if (!requireAuth(req)) return { error: 'Unauthorized' };

  const body = await readBody(req);
  const action = body.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    res.statusCode = 400;
    return { error: 'Invalid action. Must be start, stop, or restart.' };
  }

  try {
    if (ctx.docker) {
      // Standalone mode — direct Docker
      const containers = await ctx.docker.listContainers({ all: true });
      const match = containers.find((c: Dockerode.ContainerInfo) => c.Names.some(n => n === `/${params.containerName}` || n === params.containerName));
      if (!match) { res.statusCode = 404; return { error: 'Container not found' }; }
      if (match.Labels && match.Labels['insightd.internal'] === 'true') { res.statusCode = 403; return { error: 'Cannot perform actions on internal insightd containers' }; }
      const container = ctx.docker.getContainer(match.Id);
      if (action === 'start') await container.start();
      else if (action === 'stop') await container.stop({ t: 10 });
      else await container.restart({ t: 10 });
      return { status: 'success', message: `Container "${params.containerName}" ${action}ed successfully` };
    } else if (ctx.requestAction) {
      // Hub mode — MQTT
      const result = await ctx.requestAction(params.hostId, params.containerName, action);
      return result;
    } else {
      res.statusCode = 501;
      return { error: 'Container actions not available in this mode' };
    }
  } catch (err) {
    res.statusCode = 504;
    return { error: (err as Error).message };
  }
}

module.exports = { handleHealth, handleHosts, handleHostDetail, handleHostContainers, handleHostDisk, handleDashboard, handleAlerts, handleContainerDetail, handleContainerLogs, handleHostMetrics, handleLogin, handleGetSettings, handlePutSettings, handleAgentSetup, handleTimeline, handleRankings, handleTrends, handleEvents, handleGetEndpoints, handleCreateEndpoint, handleGetEndpoint, handleUpdateEndpoint, handleDeleteEndpoint, handleEndpointChecks, handleGetWebhooks, handleCreateWebhook, handleGetWebhook, handleUpdateWebhook, handleDeleteWebhook, handleTestWebhook, handleTestWebhookUnsaved, handleGetGroups, handleCreateGroup, handleGetGroup, handleUpdateGroup, handleDeleteGroup, handleAddGroupMember, handleRemoveGroupMember, handleGetBaselines, handleGetAllHealthScores, handleGetHealthScore, handleGetInsights, handleGetHostInsights, handleInsightFeedback, handleGetInsightFeedback, handleDeleteHost, handleDeleteContainer, handleSetupStatus, handleSetupPassword, handleSetupComplete, handleImageUpdates, handleVersionCheck, handleUpdateAgent, handleUpdateAllAgents, handleUpdateHub, handleContainerAvailability, handleContainerAction, handlePublicStatus, handleGetApiKeys, handleCreateApiKey, handleDeleteApiKey };

function handleGetApiKeys(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  return getApiKeys(db);
}

async function handleCreateApiKey(req: HandlerReq, res: ServerResponse, db: Database.Database): Promise<any> {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  if (!body.name || !body.name.trim()) { res.statusCode = 400; return { error: 'Name is required' }; }
  const result = createApiKey(db, body.name.trim());
  return result;
}

function handleDeleteApiKey(req: HandlerReq, res: ServerResponse, db: Database.Database, config: any, params: Record<string, string>): any {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  revokeApiKey(db, parseInt(params.keyId, 10));
  return { deleted: true };
}
