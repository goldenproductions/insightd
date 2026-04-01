const queries = require('./queries');
const { isAuthEnabled, authenticate, requireAuth, isSetupComplete } = require('./auth');
const { getSettings, putSettings } = require('../db/settings');

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
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

function handleHealth(req, res, db, config, params) {
  const health = queries.getHealth(db);
  health.authEnabled = isAuthEnabled();
  health.mode = config.mqttUrl ? 'hub' : 'standalone';
  health.setupComplete = isSetupComplete();
  return health;
}

function handleSetupStatus(req, res, db, config) {
  return {
    setupComplete: isSetupComplete(),
    mode: config.mqttUrl ? 'hub' : 'standalone',
    authEnabled: isAuthEnabled(),
  };
}

async function handleSetupPassword(req, res, db) {
  if (isSetupComplete()) { res.statusCode = 403; return { error: 'Setup already complete' }; }
  const body = await readBody(req);
  if (!body.password || body.password.length < 4) { res.statusCode = 400; return { error: 'Password must be at least 4 characters' }; }
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin.password', ?, datetime('now'))").run(body.password);
  return { saved: true };
}

function handleSetupComplete(req, res, db) {
  if (isSetupComplete()) { res.statusCode = 403; return { error: 'Setup already complete' }; }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_complete', 'true')").run();
  return { complete: true };
}

function handleHosts(req, res, db, config, params) {
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getHosts(db, threshold);
}

async function handleDeleteHost(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const hostId = decodeURIComponent(params.hostId);
  const host = db.prepare('SELECT host_id FROM hosts WHERE host_id = ?').get(hostId);
  if (!host) { res.statusCode = 404; return { error: 'Host not found' }; }

  db.prepare('DELETE FROM container_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM host_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM disk_snapshots WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM alert_state WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM service_group_members WHERE host_id = ?').run(hostId);
  db.prepare('DELETE FROM hosts WHERE host_id = ?').run(hostId);

  return { deleted: true, hostId };
}

function handleHostDetail(req, res, db, config, params) {
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

function handleHostContainers(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  return queries.getLatestContainers(db, params.hostId, showInternal);
}

function handleHostDisk(req, res, db, config, params) {
  return queries.getLatestDisk(db, params.hostId);
}

function handleDashboard(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getDashboard(db, threshold, showInternal);
}

function handleAlerts(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const activeOnly = url.searchParams.get('active') !== 'false';
  return queries.getAlerts(db, activeOnly);
}

function handleContainerDetail(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = Math.max(1, Math.min(720, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
  const latest = queries.getLatestContainers(db, params.hostId)
    .find(c => c.container_name === params.containerName);
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

async function handleContainerLogs(req, res, db, config, params, ctx) {
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
    let logs;
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
    return { error: err.message };
  }
}

function handleHostMetrics(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = Math.max(1, Math.min(720, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
  return queries.getHostMetricsHistory(db, params.hostId, hours);
}

async function handleLogin(req, res, db, config) {
  const body = await readBody(req);
  const ip = req.socket.remoteAddress;
  const token = authenticate(body.password || '', ip);
  if (!token) {
    res.statusCode = 401;
    return { error: 'Invalid password' };
  }
  return { token };
}

function handleGetSettings(req, res, db) {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const settings = getSettings(db);
  // Group by category
  const grouped = {};
  for (const s of settings) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }
  return { categories: grouped };
}

async function handlePutSettings(req, res, db) {
  if (!requireAuth(req)) {
    res.statusCode = 401;
    return { error: 'Unauthorized' };
  }
  const body = await readBody(req);
  return putSettings(db, body);
}

function handleAgentSetup(req, res, db, config) {
  const host = config.externalHost || (req.headers.host || 'localhost').replace(/:\d+$/, '');
  return {
    mqttUrl: `mqtt://${host}:1883`,
    mqttUser: config.mqttUser || '',
    mqttPass: config.mqttPass || '',
    image: 'andreas404/insightd-agent:latest',
  };
}

function handleTimeline(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  return queries.getUptimeTimeline(db, params.hostId, days);
}

function handleRankings(req, res, db, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
  return queries.getResourceRankings(db, limit);
}

function handleTrends(req, res, db, config, params) {
  return queries.getTrends(db, params.hostId);
}

function handleEvents(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  return queries.getEvents(db, params.hostId, days);
}

// --- HTTP Endpoint Monitoring ---

const endpointQueries = require('../http-monitor/queries');

function validateEndpointBody(body) {
  const errors = [];
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

function handleGetEndpoints(req, res, db) {
  return endpointQueries.getEndpointsSummary(db);
}

async function handleCreateEndpoint(req, res, db) {
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

function handleGetEndpoint(req, res, db, config, params) {
  const endpoint = endpointQueries.getEndpoint(db, parseInt(params.endpointId, 10));
  if (!endpoint) {
    res.statusCode = 404;
    return { error: 'Endpoint not found' };
  }
  const summary = endpointQueries.getEndpointSummary(db, endpoint.id);
  return { ...endpoint, ...summary };
}

async function handleUpdateEndpoint(req, res, db, config, params) {
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

async function handleDeleteEndpoint(req, res, db, config, params) {
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

function handleEndpointChecks(req, res, db, config, params) {
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
const { sendTestWebhook } = require('../../../shared/webhooks/sender');

const VALID_WEBHOOK_TYPES = ['slack', 'discord', 'telegram', 'ntfy', 'generic'];

function validateWebhookBody(body) {
  const errors = [];
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

function handleGetWebhooks(req, res, db) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  return webhookQueries.getWebhooks(db);
}

async function handleCreateWebhook(req, res, db) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  const errors = validateWebhookBody(body);
  if (errors.length > 0) { res.statusCode = 400; return { error: errors.join('; ') }; }
  res.statusCode = 201;
  return webhookQueries.createWebhook(db, body);
}

function handleGetWebhook(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const wh = webhookQueries.getWebhook(db, parseInt(params.webhookId, 10));
  if (!wh) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return wh;
}

async function handleUpdateWebhook(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const existing = webhookQueries.getWebhook(db, id);
  if (!existing) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  const body = await readBody(req);
  return webhookQueries.updateWebhook(db, id, body);
}

async function handleDeleteWebhook(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const result = webhookQueries.deleteWebhook(db, id);
  if (!result.deleted) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return result;
}

async function handleTestWebhook(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.webhookId, 10);
  const wh = webhookQueries.getWebhook(db, id);
  if (!wh) { res.statusCode = 404; return { error: 'Webhook not found' }; }
  return sendTestWebhook(wh);
}

async function handleTestWebhookUnsaved(req, res, db) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const body = await readBody(req);
  const errors = validateWebhookBody(body);
  if (errors.length > 0) { res.statusCode = 400; return { error: errors.join('; ') }; }
  return sendTestWebhook(body);
}

// --- Service Groups ---

const groupQueries = require('./group-queries');

function handleGetGroups(req, res, db) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const showInternal = url.searchParams.get('showInternal') === 'true';
  return groupQueries.getGroups(db, showInternal);
}

async function handleCreateGroup(req, res, db) {
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

function handleGetGroup(req, res, db, config, params) {
  const detail = groupQueries.getGroupDetail(db, parseInt(params.groupId, 10));
  if (!detail) { res.statusCode = 404; return { error: 'Group not found' }; }
  return detail;
}

async function handleUpdateGroup(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const id = parseInt(params.groupId, 10);
  if (!groupQueries.getGroup(db, id)) { res.statusCode = 404; return { error: 'Group not found' }; }
  const body = await readBody(req);
  return groupQueries.updateGroup(db, id, body);
}

async function handleDeleteGroup(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const result = groupQueries.deleteGroup(db, parseInt(params.groupId, 10));
  if (!result.deleted) { res.statusCode = 404; return { error: 'Group not found' }; }
  return result;
}

async function handleAddGroupMember(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const groupId = parseInt(params.groupId, 10);
  if (!groupQueries.getGroup(db, groupId)) { res.statusCode = 404; return { error: 'Group not found' }; }
  const body = await readBody(req);
  if (!body.hostId || !body.containerName) { res.statusCode = 400; return { error: 'hostId and containerName are required' }; }
  return groupQueries.addGroupMember(db, groupId, body.hostId, body.containerName);
}

async function handleRemoveGroupMember(req, res, db, config, params) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  const groupId = parseInt(params.groupId, 10);
  const body = await readBody(req);
  if (!body.hostId || !body.containerName) { res.statusCode = 400; return { error: 'hostId and containerName are required' }; }
  return groupQueries.removeGroupMember(db, groupId, body.hostId, body.containerName);
}

// --- Insights ---

const insightQueries = require('../insights/queries');

function handleGetBaselines(req, res, db, config, params) {
  return insightQueries.getBaselines(db, params.entityType, decodeURIComponent(params.entityId));
}

function handleGetAllHealthScores(req, res, db) {
  return insightQueries.getAllHealthScores(db);
}

function handleGetHealthScore(req, res, db, config, params) {
  const score = insightQueries.getHealthScore(db, params.entityType, decodeURIComponent(params.entityId));
  if (!score) { res.statusCode = 404; return { error: 'No health score found' }; }
  score.factors = JSON.parse(score.factors);
  return score;
}

function handleGetInsights(req, res, db) {
  return insightQueries.getInsights(db);
}

function handleGetHostInsights(req, res, db, config, params) {
  return insightQueries.getHostInsights(db, params.hostId);
}

// --- Version + Updates ---

function handleVersionCheck(req, res) {
  const { getVersionInfo } = require('../version-check');
  return getVersionInfo();
}

async function handleUpdateAgent(req, res, db, config, params, ctx) {
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
    return { error: err.message };
  }
}

async function handleUpdateAllAgents(req, res, db, config, params, ctx) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  if (!ctx.requestUpdate) { res.statusCode = 501; return { error: 'Update not available in standalone mode' }; }
  const { snoozeAlerts } = require('../alert-snooze');
  snoozeAlerts(15);
  const hosts = queries.getHosts(db, config.collectIntervalMinutes * 2);
  const { getVersionInfo } = require('../version-check');
  const vi = getVersionInfo();
  const tag = vi.latestAgentVersion || vi.currentVersion;
  const image = `andreas404/insightd-agent:${tag}`;
  const results = [];
  for (const host of hosts) {
    try {
      const result = await ctx.requestUpdate(host.host_id, 'agent', image);
      results.push({ hostId: host.host_id, ...result });
    } catch (err) {
      results.push({ hostId: host.host_id, status: 'failed', error: err.message });
    }
  }
  return { results };
}

async function handleUpdateHub(req, res, db, config, params, ctx) {
  if (!requireAuth(req)) { res.statusCode = 401; return { error: 'Unauthorized' }; }
  if (!ctx.requestUpdate) { res.statusCode = 501; return { error: 'Update not available in standalone mode' }; }
  const { snoozeAlerts } = require('../alert-snooze');
  snoozeAlerts(10);
  // Find the agent on the same host as the hub
  const hubHostId = config.hostId || 'local';
  const hosts = queries.getHosts(db, config.collectIntervalMinutes * 2);
  const localAgent = hosts.find(h => h.host_id === hubHostId && h.is_online);
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
    return { error: err.message };
  }
}

module.exports = { handleHealth, handleHosts, handleHostDetail, handleHostContainers, handleHostDisk, handleDashboard, handleAlerts, handleContainerDetail, handleContainerLogs, handleHostMetrics, handleLogin, handleGetSettings, handlePutSettings, handleAgentSetup, handleTimeline, handleRankings, handleTrends, handleEvents, handleGetEndpoints, handleCreateEndpoint, handleGetEndpoint, handleUpdateEndpoint, handleDeleteEndpoint, handleEndpointChecks, handleGetWebhooks, handleCreateWebhook, handleGetWebhook, handleUpdateWebhook, handleDeleteWebhook, handleTestWebhook, handleTestWebhookUnsaved, handleGetGroups, handleCreateGroup, handleGetGroup, handleUpdateGroup, handleDeleteGroup, handleAddGroupMember, handleRemoveGroupMember, handleGetBaselines, handleGetAllHealthScores, handleGetHealthScore, handleGetInsights, handleGetHostInsights, handleDeleteHost, handleSetupStatus, handleSetupPassword, handleSetupComplete, handleVersionCheck, handleUpdateAgent, handleUpdateAllAgents, handleUpdateHub };
