const queries = require('./queries');

function handleHealth(req, res, db, config, params) {
  return queries.getHealth(db);
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
  const hours = parseInt(url.searchParams.get('hours') || '24', 10);
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

function handleHostMetrics(req, res, db, config, params) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hours = parseInt(url.searchParams.get('hours') || '24', 10);
  return queries.getHostMetricsHistory(db, params.hostId, hours);
}

module.exports = { handleHealth, handleHosts, handleHostDetail, handleHostContainers, handleHostDisk, handleDashboard, handleAlerts, handleContainerDetail, handleHostMetrics };
