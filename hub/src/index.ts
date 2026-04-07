import logger = require('../../shared/utils/logger');
import type Database from 'better-sqlite3';
import type { Server } from 'http';

const { config, validate } = require('./config') as { config: any; validate: () => string[] };
const { getDb, closeDb } = require('./db/connection') as { getDb: (path: string) => Database.Database; closeDb: () => void };
const { bootstrap } = require('./db/schema') as { bootstrap: (db: Database.Database) => void };

async function main(): Promise<void> {
  const mode = config.mqttUrl ? 'hub' : 'standalone';
  logger.info('main', `Starting insightd ${mode} mode...`);

  // Validate config
  const warnings = validate();
  warnings.forEach((w: string) => logger.warn('config', w));

  // Init database
  const db = getDb(config.dbPath);
  bootstrap(db);

  // Give auth module access to DB for password-in-settings
  const { setDb: setAuthDb } = require('./web/auth') as { setDb: (db: Database.Database) => void };
  setAuthDb(db);

  // Set setup_complete for existing installs (has hosts = not first run)
  const hasHosts = db.prepare('SELECT COUNT(*) as c FROM hosts').get() as { c: number };
  if (hasHosts.c > 0) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('setup_complete', 'true')").run();
  }

  if (mode === 'hub') {
    // Hub mode: receive data via MQTT, run digest + alerts
    const mqttModule = require('./mqtt') as {
      startSubscriber: (db: Database.Database, config: any) => Promise<any>;
      disconnect: () => void;
      requestContainerLogs: Function;
      requestAgentUpdate: Function;
      requestContainerAction: Function;
    };
    const { startSubscriber, disconnect } = mqttModule;
    const { startHubScheduler, stopScheduler } = require('./scheduler') as {
      startHubScheduler: (db: Database.Database, config: any) => void;
      stopScheduler: () => void;
    };

    try {
      await startSubscriber(db, config);
    } catch (err) {
      logger.error('mqtt', 'Cannot connect to MQTT broker', err);
      process.exit(1);
    }

    startHubScheduler(db, config);

    let webServer: Server | undefined;
    if (config.web.enabled) {
      const { startWebServer } = require('./web/server') as { startWebServer: (db: Database.Database, config: any, ctx: any) => Server };
      webServer = startWebServer(db, config, { requestLogs: mqttModule.requestContainerLogs, requestUpdate: mqttModule.requestAgentUpdate, requestAction: mqttModule.requestContainerAction });
    }

    logger.info('main', 'insightd hub is running (MQTT mode)');

    const shutdown = (): void => {
      logger.info('main', 'Shutting down gracefully...');
      stopScheduler();
      if (webServer) webServer.close();
      disconnect();
      closeDb();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    // Standalone mode: collect locally + digest + alerts (backwards compatible)
    const Docker = require('dockerode');
    const docker = new Docker({ socketPath: config.dockerSocket });

    try {
      const info = await docker.info();
      logger.info('docker', `Connected — ${info.Containers} containers, ${info.Images} images`);
    } catch (err) {
      logger.error('docker', 'Cannot connect to Docker socket. Is it mounted?', err);
      process.exit(1);
    }

    const { startStandaloneScheduler, stopScheduler } = require('./scheduler') as {
      startStandaloneScheduler: (db: Database.Database, docker: any, config: any) => void;
      stopScheduler: () => void;
    };
    startStandaloneScheduler(db, docker, config);

    let webServer: Server | undefined;
    if (config.web.enabled) {
      const { startWebServer } = require('./web/server') as { startWebServer: (db: Database.Database, config: any, ctx: any) => Server };
      webServer = startWebServer(db, config, { docker });
    }

    logger.info('main', 'insightd is running (standalone mode)');

    const shutdown = (): void => {
      logger.info('main', 'Shutting down gracefully...');
      stopScheduler();
      if (webServer) webServer.close();
      closeDb();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  process.on('uncaughtException', (err: Error) => logger.error('main', 'Uncaught exception', err));
  process.on('unhandledRejection', (err: unknown) => logger.error('main', 'Unhandled rejection', err));
}

main().catch((err: Error) => {
  logger.error('main', 'Fatal startup error', err);
  process.exit(1);
});
