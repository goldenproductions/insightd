const http = require('http');
const fs = require('fs');
const path = require('path');
import logger = require('../../../shared/utils/logger');
import type { IncomingMessage, ServerResponse, Server } from 'http';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';

const { createRouter } = require('./router') as { createRouter: () => { add: (method: string, pattern: string, handler: Function) => void; match: (method: string, pathname: string) => { handler: Function; params: Record<string, string> } | null } };
const handlers = require('./handlers');
const { isRateLimited } = require('./rate-limit') as { isRateLimited: (req: IncomingMessage) => boolean };

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR: string = path.join(__dirname, 'public');

interface WebServerContext {
  docker?: Dockerode;
  requestLogs?: Function;
  requestUpdate?: Function;
  requestAction?: Function;
}

interface WebConfig {
  web: {
    enabled: boolean;
    port: number;
    host: string;
  };
  [key: string]: any;
}

function startWebServer(db: Database.Database, config: WebConfig, context?: WebServerContext): Server {
  const ctx = context || {};
  const router = createRouter();

  router.add('GET', '/api/health', handlers.handleHealth);
  router.add('GET', '/api/hosts', handlers.handleHosts);
  router.add('DELETE', '/api/hosts/:hostId', handlers.handleDeleteHost);
  router.add('PUT', '/api/hosts/:hostId/group', handlers.handleSetHostGroup);
  router.add('DELETE', '/api/hosts/:hostId/group', handlers.handleResetHostGroup);
  router.add('GET', '/api/hosts/:hostId', handlers.handleHostDetail);
  router.add('GET', '/api/hosts/:hostId/timeline', handlers.handleTimeline);
  router.add('GET', '/api/hosts/:hostId/trends', handlers.handleTrends);
  router.add('GET', '/api/hosts/:hostId/events', handlers.handleEvents);
  router.add('GET', '/api/hosts/:hostId/metrics', handlers.handleHostMetrics);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName/logs', handlers.handleContainerLogs);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName/availability', handlers.handleContainerAvailability);
  router.add('POST', '/api/hosts/:hostId/containers/:containerName/action', handlers.handleContainerAction);
  router.add('DELETE', '/api/hosts/:hostId/containers/:containerName', handlers.handleDeleteContainer);
  router.add('GET', '/api/hosts/:hostId/containers/:containerName', handlers.handleContainerDetail);
  router.add('GET', '/api/hosts/:hostId/containers', handlers.handleHostContainers);
  router.add('GET', '/api/hosts/:hostId/disk', handlers.handleHostDisk);
  router.add('GET', '/api/status', handlers.handlePublicStatus);
  router.add('GET', '/api/dashboard', handlers.handleDashboard);
  router.add('GET', '/api/rankings', handlers.handleRankings);
  router.add('GET', '/api/alerts', handlers.handleAlerts);
  router.add('GET', '/api/agent-setup', handlers.handleAgentSetup);
  router.add('POST', '/api/auth', handlers.handleLogin);
  router.add('GET', '/api/api-keys', handlers.handleGetApiKeys);
  router.add('POST', '/api/api-keys', handlers.handleCreateApiKey);
  router.add('DELETE', '/api/api-keys/:keyId', handlers.handleDeleteApiKey);
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
  router.add('GET', '/api/groups', handlers.handleGetGroups);
  router.add('POST', '/api/groups', handlers.handleCreateGroup);
  router.add('GET', '/api/groups/:groupId', handlers.handleGetGroup);
  router.add('PUT', '/api/groups/:groupId', handlers.handleUpdateGroup);
  router.add('DELETE', '/api/groups/:groupId', handlers.handleDeleteGroup);
  router.add('POST', '/api/groups/:groupId/members', handlers.handleAddGroupMember);
  router.add('DELETE', '/api/groups/:groupId/members', handlers.handleRemoveGroupMember);
  router.add('GET', '/api/baselines/:entityType/:entityId', handlers.handleGetBaselines);
  router.add('GET', '/api/health-scores', handlers.handleGetAllHealthScores);
  router.add('GET', '/api/health-scores/:entityType/:entityId', handlers.handleGetHealthScore);
  router.add('GET', '/api/insights', handlers.handleGetInsights);
  router.add('GET', '/api/hosts/:hostId/insights', handlers.handleGetHostInsights);
  router.add('POST', '/api/insights/feedback', handlers.handleInsightFeedback);
  router.add('GET', '/api/insights/feedback', handlers.handleGetInsightFeedback);
  router.add('GET', '/api/setup/status', handlers.handleSetupStatus);
  router.add('POST', '/api/setup/password', handlers.handleSetupPassword);
  router.add('POST', '/api/setup/complete', handlers.handleSetupComplete);
  router.add('GET', '/api/image-updates', handlers.handleImageUpdates);
  router.add('GET', '/api/version-check', handlers.handleVersionCheck);
  router.add('POST', '/api/update/agent/:hostId', handlers.handleUpdateAgent);
  router.add('POST', '/api/update/agents', handlers.handleUpdateAllAgents);
  router.add('POST', '/api/update/hub', handlers.handleUpdateHub);

  const server: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
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
      const match = router.match(req.method!, pathname);
      if (!match) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        Promise.resolve(match.handler(req, res, db, config, match.params, ctx))
          .then((data: any) => {
            if (!res.writableEnded) res.end(JSON.stringify(data));
          })
          .catch((err: Error) => {
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

    const ext: string = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err: NodeJS.ErrnoException | null, data: Buffer) => {
      if (err) {
        // SPA fallback: serve index.html for non-file routes
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2: NodeJS.ErrnoException | null, indexData: Buffer) => {
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
