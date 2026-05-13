import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { bootstrap } = require('../../src/db/schema');
const { generateInsights } = require('../../src/insights/detector');
const { processAlerts } = require('../../src/alerts/evaluator');
const { buildExplanation } = require('../../src/insights/explain');
const { loadRegistry } = require('../../src/log-patterns/loader');
const { recordMatch } = require('../../src/log-patterns/events');
const { getRegistry, resetRegistryForTest } = require('../../src/log-patterns');

function writeRegistry(): { dir: string; registry: any } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lpat-int-'));
  writeFileSync(path.join(dir, 'jellyfin.yaml'),
    `images: ["*jellyfin*"]\ntitle: jelly\npatterns:\n` +
    `  - { id: media_file_corrupted, regex: 'File ended prematurely', severity: warning, explains_alert: [respawn_loop] }\n`);
  const registry = loadRegistry(dir);
  return { dir, registry };
}

function setup(): { db: Database.Database; cleanup: () => void; registry: any; dir: string } {
  resetRegistryForTest();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);

  db.prepare(
    "INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('h1', datetime('now'), datetime('now'))"
  ).run();
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_id, container_name, status, collected_at)
    VALUES ('h1', 'c1', 'jellyfin', 'running', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES ('h1', 'jellyfin', datetime('now'), datetime('now'), NULL)
  `).run();

  const { dir, registry } = writeRegistry();
  // Pre-populate the singleton with our temp-dir registry so stampExplanation
  // doesn't accidentally load the real shared/log-patterns/ directory.
  resetRegistryForTest();
  getRegistry(dir);

  return {
    db,
    cleanup: () => { rmSync(dir, { recursive: true }); resetRegistryForTest(); },
    registry,
    dir,
  };
}

const baseAlertsConfig = {
  enabled: true, to: 'test@example.com', cooldownMinutes: 60,
  cpuPercent: 80, memoryMb: 0, diskPercent: 90, restartCount: 3,
  containerDown: true,
  hostCpuPercent: 90, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
  hostOffline: false, hostOfflineMinutes: 15,
  containerUnhealthy: false, imagePullFailure: false, excludeContainers: '',
  endpointDown: false, endpointFailureThreshold: 3,
  containerMemoryLimitPercent: 0, containerCpuLimitPercent: 0,
  flapStabilizeMinutes: 0, diskCriticalPercent: 95,
  mailCriticalOnly: true, suppressDependents: true,
  respawnLoop: false,
};
const evalConfig = (): any => ({ alerts: baseAlertsConfig, smtp: { host: '', port: 0, user: '', pass: '', from: '' } });

test('log-pattern match -> insight materialized with log_match extras', () => {
  const { db, cleanup, registry } = setup();
  try {
    recordMatch(db, {
      patternId: 'media_file_corrupted',
      hostId: 'h1',
      containerName: 'jellyfin',
      image: 'linuxserver/jellyfin',
      matchedLine: '[matroska,webm @ 0x...] File ended prematurely',
      contextBefore: ['decode start'],
      contextAfter: ['exit code 1'],
      captures: {},
      lineHash: 'h-1',
    }, registry);

    generateInsights(db);

    const insight = db.prepare(
      "SELECT id, evidence FROM insights WHERE metric = 'log_pattern_match'"
    ).get() as { id: number; evidence: string } | undefined;
    assert.ok(insight, 'expected log_pattern_match insight row');
    const ev = JSON.parse(insight.evidence);
    assert.equal(ev.pattern_id, 'media_file_corrupted');
    assert.equal(ev.occurrences, 1);

    const insightRow = db.prepare('SELECT * FROM insights WHERE id = ?').get(insight.id);
    const explanation = buildExplanation(db, insightRow);
    assert.ok(Array.isArray(explanation.extras));
    const lm = explanation.extras.find((b: any) => b.kind === 'log_match');
    assert.ok(lm, 'expected log_match extras block');
    assert.equal(lm.pattern_id, 'media_file_corrupted');
    assert.equal(lm.matched_line, '[matroska,webm @ 0x...] File ended prematurely');
  } finally { cleanup(); }
});

test('alert stamping: new respawn_loop gets explained_by_pattern_event_id when matching log event exists', () => {
  const { db, cleanup, registry } = setup();
  try {
    recordMatch(db, {
      patternId: 'media_file_corrupted',
      hostId: 'h1', containerName: 'jellyfin', image: 'linuxserver/jellyfin',
      matchedLine: 'File ended prematurely',
      contextBefore: [], contextAfter: [], captures: {}, lineHash: 'h-2',
    }, registry);
    const evRow = db.prepare("SELECT id FROM log_pattern_events").get() as { id: number };

    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalConfig(), { triggered, resolved: [] });

    const alert = db.prepare(
      `SELECT id, explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop' AND target = 'jellyfin'`
    ).get() as { id: number; explained_by_pattern_event_id: number | null };
    assert.ok(alert, 'expected alert_state row');
    assert.equal(alert.explained_by_pattern_event_id, evRow.id,
      'alert should be stamped with the matching log_pattern_event id');
  } finally { cleanup(); }
});

test('alert stamping: no log event -> no stamp', () => {
  const { db, cleanup } = setup();
  try {
    const triggered = [{
      type: 'respawn_loop', hostId: 'h1', target: 'jellyfin',
      message: 'respawn loop', value: 25, threshold: 20,
    }];
    processAlerts(db, evalConfig(), { triggered, resolved: [] });
    const alert = db.prepare(
      `SELECT explained_by_pattern_event_id FROM alert_state WHERE alert_type = 'respawn_loop'`
    ).get() as { explained_by_pattern_event_id: number | null };
    assert.equal(alert.explained_by_pattern_event_id, null);
  } finally { cleanup(); }
});
