import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { bootstrap } = require('../../src/db/schema');
const { processAlerts } = require('../../src/alerts/evaluator');
const { recordMatch } = require('../../src/log-patterns/events');
const { loadRegistry } = require('../../src/log-patterns/loader');
const { getRegistry, resetRegistryForTest } = require('../../src/log-patterns');

function setupRegistry(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lpat-stamp-'));
  writeFileSync(path.join(dir, 'jellyfin.yaml'),
    `images: ["*jellyfin*"]\ntitle: jelly\npatterns:\n` +
    `  - { id: media_file_corrupted, regex: 'File ended prematurely', severity: warning, explains_alert: [respawn_loop] }\n`);
  return dir;
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id) VALUES ('h1')`).run();
  return db;
}

const baseAlerts = {
  enabled: true, to: '', cooldownMinutes: 60,
  cpuPercent: 0, memoryMb: 0, diskPercent: 0, restartCount: 0,
  containerDown: false,
  hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
  hostOffline: false, hostOfflineMinutes: 15,
  containerUnhealthy: false, imagePullFailure: false, excludeContainers: '',
  endpointDown: false, endpointFailureThreshold: 3,
  containerMemoryLimitPercent: 0, containerCpuLimitPercent: 0,
  flapStabilizeMinutes: 0, diskCriticalPercent: 95,
  mailCriticalOnly: true, suppressDependents: false,
  respawnLoop: false,
};
const evalCfg = (): any => ({ alerts: baseAlerts, smtp: { host: '', port: 0, user: '', pass: '', from: '' } });

test('new respawn_loop alert is stamped with matching log_pattern_event id', () => {
  resetRegistryForTest();
  const dir = setupRegistry();
  try {
    const db = setupDb();
    const reg = loadRegistry(dir);
    recordMatch(db, {
      patternId: 'media_file_corrupted',
      hostId: 'h1', containerName: 'jellyfin', image: 'linuxserver/jellyfin',
      matchedLine: 'File ended prematurely',
      contextBefore: [], contextAfter: [], captures: {}, lineHash: 'h-1',
    }, reg);
    const evRow = db.prepare("SELECT id FROM log_pattern_events").get() as { id: number };

    // Pre-populate singleton cache with our temp dir so stampExplanation finds it
    // regardless of the default arg passed inside the helper.
    resetRegistryForTest();
    getRegistry(dir);

    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalCfg(), { triggered, resolved: [] });

    const alert = db.prepare(
      `SELECT explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop'`
    ).get() as { explained_by_pattern_event_id: number | null };
    assert.equal(alert.explained_by_pattern_event_id, evRow.id);
  } finally {
    rmSync(dir, { recursive: true });
    resetRegistryForTest();
  }
});

test('no matching log event -> explained_by_pattern_event_id stays NULL', () => {
  resetRegistryForTest();
  const dir = setupRegistry();
  try {
    const db = setupDb();
    // Pre-populate singleton cache: registry is loaded but DB has no events.
    getRegistry(dir);

    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalCfg(), { triggered, resolved: [] });
    const alert = db.prepare(
      `SELECT explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop'`
    ).get() as { explained_by_pattern_event_id: number | null };
    assert.equal(alert.explained_by_pattern_event_id, null);
  } finally {
    rmSync(dir, { recursive: true });
    resetRegistryForTest();
  }
});
