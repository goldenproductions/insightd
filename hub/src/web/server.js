const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../../../shared/utils/logger');
const { createRouter } = require('./router');
const handlers = require('./handlers');
const { isRateLimited } = require('./rate-limit');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function startWebServer(db, config, context) {
  const ctx = context || {};
  const router = createRouter();

  router.add('GET', '/api/health', handlers.handleHealth);
  router.add('GET', '/api/hosts', handlers.handleHosts);
  router.add('GET', '/api/hosts/:hostId', handlers.handleHostDetail);
  router.add('GET', '/api/hosts/:hostId/timeline', handlers.handleTimeline);
  router.add('GET', '/api/hosts/:hostId/trends', handlers.handleTrends);
  router.add('GET', '/api/hosts/:hostId/events', handlers.handleEvents);
  router.add('GET', '/api/hosts/:hostId/metrics', handlers.handleHostMetrics);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName/logs', handlers.handleContainerLogs);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName', handlers.handleContainerDetail);
  router.add('GET', '/api/hosts/:hostId/containers', handlers.handleHostContainers);
  router.add('GET', '/api/hosts/:hostId/disk', handlers.handleHostDisk);
  router.add('GET', '/api/dashboard', handlers.handleDashboard);
  router.add('GET', '/api/rankings', handlers.handleRankings);
  router.add('GET', '/api/alerts', handlers.handleAlerts);
  router.add('GET', '/api/agent-setup', handlers.handleAgentSetup);
  router.add('POST', '/api/auth', handlers.handleLogin);
  router.add('GET', '/api/settings', handlers.handleGetSettings);
  router.add('PUT', '/api/settings', handlers.handlePutSettings);
  router.add('GET', '/api/endpoints', handlers.handleGetEndpoints);
  router.add('POST', '/api/endpoints', handlers.handleCreateEndpoint);
  router.add('GET', '/api/endpoints/:endpointId/checks', handlers.handleEndpointChecks);
  router.add('GET', '/api/endpoints/:endpointId', handlers.handleGetEndpoint);
  router.add('PUT', '/api/endpoints/:endpointId', handlers.handleUpdateEndpoint);
  router.add('DELETE', '/api/endpoints/:endpointId', handlers.handleDeleteEndpoint);
  router.add('GET', '/api/webhooks', handlers.handleGetWebhooks);
  router.add('POST', '/api/webhooks', handlers.handleCreateWebhook);
  router.add('POST', '/api/webhooks/test', handlers.handleTestWebhookUnsaved);
  router.add('POST', '/api/webhooks/:webhookId/test', handlers.handleTestWebhook);
  router.add('GET', '/api/webhooks/:webhookId', handlers.handleGetWebhook);
  router.add('PUT', '/api/webhooks/:webhookId', handlers.handleUpdateWebhook);
  router.add('DELETE', '/api/webhooks/:webhookId', handlers.handleDeleteWebhook);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Rate limiting
    if (isRateLimited(req)) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const match = router.match(req.method, pathname);
      if (!match) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        Promise.resolve(match.handler(req, res, db, config, match.params, ctx))
          .then(data => {
            if (!res.writableEnded) res.end(JSON.stringify(data));
          })
          .catch(err => {
            logger.error('web', 'API error', err);
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
          });
      } catch (err) {
        logger.error('web', 'API error', err);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // Static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(PUBLIC_DIR, filePath);

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback: serve index.html for non-file routes
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
          if (err2) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(indexData);
        });
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.end(data);
    });
  });

  const { port, host } = config.web;
  server.listen(port, host, () => {
    logger.info('web', `Web UI available at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });

  return server;
}

module.exports = { startWebServer };
