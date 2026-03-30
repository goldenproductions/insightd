const queries = require('./queries');
const { isAuthEnabled, authenticate, requireAuth } = require('./auth');
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
  return health;
}

function handleHosts(req, res, db, config, params) {
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getHosts(db, threshold);
}

function handleHostDetail(req, res, db, config, params) {
  const threshold = config.collectIntervalMinutes * 2;
  const detail = queries.getHostDetail(db, params.hostId, threshold);
  if (!detail) {
    res.statusCode = 404;
    return { error: 'Host not found' };
  }
  return detail;
}

function handleHostContainers(req, res, db, config, params) {
  return queries.getLatestContainers(db, params.hostId);
}

function handleHostDisk(req, res, db, config, params) {
  return queries.getLatestDisk(db, params.hostId);
}

function handleDashboard(req, res, db, config, params) {
  const threshold = config.collectIntervalMinutes * 2;
  return queries.getDashboard(db, threshold);
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

module.exports = { handleHealth, handleHosts, handleHostDetail, handleHostContainers, handleHostDisk, handleDashboard, handleAlerts, handleContainerDetail, handleContainerLogs, handleHostMetrics, handleLogin, handleGetSettings, handlePutSettings, handleAgentSetup, handleTimeline, handleRankings, handleTrends, handleEvents };
