import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Real hub modules — proves Tasks 1-7 actually compose into a pipeline.
const { bootstrap } = require('../../src/db/schema');
const { generateInsights } = require('../../src/insights/detector');
const { evaluateAlerts, processAlerts } = require('../../src/alerts/evaluator');
const { buildExplanation } = require('../../src/insights/explain');

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  bootstrap(db);

  db.prepare(
    "INSERT INTO hosts (host_id, first_seen, last_seen) VALUES ('h1', datetime('now'), datetime('now'))"
  ).run();

  // Recent container snapshot — detector + alert evaluator both map
  // container_id → (host_id, container_name) via the latest snapshot.
  db.prepare(`
    INSERT INTO container_snapshots (host_id, container_id, container_name, status, collected_at, cpu_percent, memory_mb)
    VALUES ('h1', 'c1', 'jellyfin', 'running', datetime('now'), 95, 800)
  `).run();

  // Registry entry so the main insights container loop doesn't filter jellyfin out.
  db.prepare(`
    INSERT INTO containers (host_id, container_name, first_seen, last_seen, removed_at)
    VALUES ('h1', 'jellyfin', datetime('now'), datetime('now'), NULL)
  `).run();

  db.prepare(`
    INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen)
    VALUES ('a-ffmpeg', '/usr/bin/ffmpeg -i /data/movie.mkv', 'ffmpeg', datetime('now'))
  `).run();

  // 25 fast-crashing ffmpeg spawns within last 15 min, all 2s lifetime —
  // clears the 20-spawn + 60%-short thresholds.
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, ppid, argv_hash, started_at, exited_at, lifetime_ms, source)
    VALUES ('h1', 'c1', ?, 1, 'a-ffmpeg', ?, ?, 2000, 'docker')
  `);
  for (let i = 0; i < 25; i++) {
    const startedAt = isoMinutesAgo(14 - i * 0.05);
    const exitedAt = new Date(Date.parse(startedAt.replace(' ', 'T') + 'Z') + 2000)
      .toISOString().slice(0, 19).replace('T', ' ');
    stmt.run(2000 + i, startedAt, exitedAt);
  }

  return db;
}

const baseAlertsConfig = {
  enabled: true,
  to: 'test@example.com',
  cooldownMinutes: 60,
  cpuPercent: 80,
  memoryMb: 0,
  diskPercent: 90,
  restartCount: 3,
  containerDown: true,
  hostCpuPercent: 90,
  hostMemoryAvailableMb: 0,
  hostLoadThreshold: 0,
  hostOffline: false,
  hostOfflineMinutes: 15,
  containerUnhealthy: false,
  imagePullFailure: false,
  excludeContainers: '',
  endpointDown: false,
  endpointFailureThreshold: 3,
  containerMemoryLimitPercent: 0,
  containerCpuLimitPercent: 0,
  flapStabilizeMinutes: 0, // disable flap-damp for synchronous test
  diskCriticalPercent: 95,
  mailCriticalOnly: true,
  suppressDependents: true,
  respawnLoop: true,
  respawnWindowMin: 15,
  respawnMinSpawns: 20,
  respawnShortLifetimeMs: 10_000,
  respawnShortLifetimeRatio: 0.6,
};

function evalConfig(): any {
  return {
    alerts: baseAlertsConfig,
    smtp: { host: '', port: 0, user: '', pass: '', from: '' },
  };
}

test('pipeline: detector → insight → alert → explain (respawn_loop)', () => {
  const db = setup();

  // Run the detector + insight materialization
  generateInsights(db);

  // Assert insight row
  const insight = db.prepare(
    "SELECT id, entity_id, category, metric, evidence FROM insights WHERE metric = 'process_spawn_count'"
  ).get() as { id: number; entity_id: string; category: string; metric: string; evidence: string } | undefined;
  assert.ok(insight, 'expected respawn_loop insight row');
  assert.equal(insight!.category, 'availability');
  assert.equal(insight!.entity_id, 'h1/jellyfin');

  // Run alert evaluator — discovery layer
  const res = evaluateAlerts(db, evalConfig());
  const respawnAlerts = res.triggered.filter((a: any) => a.type === 'respawn_loop');
  assert.equal(respawnAlerts.length, 1, 'expected exactly one respawn_loop alert');
  assert.equal(respawnAlerts[0].hostId, 'h1');
  assert.equal(respawnAlerts[0].target, 'jellyfin');

  // Explain endpoint shape — chart + extras
  const insightRow = db.prepare('SELECT * FROM insights WHERE id = ?').get(insight!.id);
  const explanation = buildExplanation(db, insightRow);
  assert.equal(explanation.chart.kind, 'restart_histogram');
  assert.ok(Array.isArray(explanation.extras), 'expected extras array');
  assert.equal(explanation.extras[0].kind, 'top_argvs');
  assert.equal(explanation.extras[0].rows[0].argv_hash, 'a-ffmpeg');
});

test('pipeline: DEPS suppression stamps high_cpu when respawn_loop fires', () => {
  const db = setup();

  // Pre-existing high_cpu alert on the same container, NOT yet suppressed.
  db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message)
    VALUES ('h1', 'high_cpu', 'jellyfin', datetime('now'), datetime('now'), 0, 'cpu high')
  `).run();

  // Fire respawn_loop in the same cycle. evaluateAlerts only discovers;
  // processAlerts is what writes alert_state + applies retroactive suppression.
  const evaluation = evaluateAlerts(db, evalConfig());
  processAlerts(db, evalConfig(), evaluation);

  // Confirm respawn_loop landed in alert_state
  const respawn = db.prepare(
    `SELECT id FROM alert_state WHERE alert_type = 'respawn_loop' AND target = 'jellyfin' AND resolved_at IS NULL`
  ).get() as { id: number } | undefined;
  assert.ok(respawn, 'expected respawn_loop alert_state row');

  // Confirm high_cpu got retroactively stamped with suppressed_by_state_id = respawn.id
  const cpu = db.prepare(
    `SELECT suppressed_by_state_id FROM alert_state WHERE alert_type = 'high_cpu' AND target = 'jellyfin' AND resolved_at IS NULL`
  ).get() as { suppressed_by_state_id: number | null };
  assert.equal(
    cpu.suppressed_by_state_id,
    respawn!.id,
    'high_cpu should be retroactively stamped as suppressed by respawn_loop',
  );
});
