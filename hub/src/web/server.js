const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../../../shared/utils/logger');
const { createRouter } = require('./router');
const handlers = require('./handlers');

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
  router.add('GET', '/api/hosts/:hostId/metrics', handlers.handleHostMetrics);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName/logs', handlers.handleContainerLogs);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName', handlers.handleContainerDetail);
  router.add('GET', '/api/hosts/:hostId/containers', handlers.handleHostContainers);
  router.add('GET', '/api/hosts/:hostId/disk', handlers.handleHostDisk);
  router.add('GET', '/api/dashboard', handlers.handleDashboard);
  router.add('GET', '/api/alerts', handlers.handleAlerts);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

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
