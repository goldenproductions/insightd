import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { buildAftermath } = require('../hub/src/alerts/aftermath');

test('aftermath summary partitions still-firing vs cleared children', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
              VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  const parent = { id: 1, alert_type: 'host_offline', host_id: 'h1', target: 'system', triggered_at: '2026-05-11 08:00:00' };
  db.prepare(`INSERT INTO alert_state (id, host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, resolved_at, suppressed_by_state_id)
              VALUES
              (2, 'h1', 'container_down', 'nginx',    datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'), 1),
              (3, 'h1', 'container_down', 'redis',    datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'), 1),
              (4, 'h1', 'container_down', 'postgres', datetime('now'), datetime('now'), 1, datetime('now'), NULL, 1)`).run();
  const summary = buildAftermath(db, parent);
  assert.equal(summary.parent.alert_type, 'host_offline');
  assert.equal(summary.stillFiring.length, 1);
  assert.equal(summary.stillFiring[0].target, 'postgres');
  assert.equal(summary.cleared.length, 2);
  const clearedTargets = summary.cleared.map((c: any) => c.target).sort();
  assert.deepEqual(clearedTargets, ['nginx', 'redis']);
});

test('aftermath with zero children returns empty arrays', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
              VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  const summary = buildAftermath(db, { id: 1, alert_type: 'host_offline', host_id: 'h1', target: 'system', triggered_at: '2026-05-11 08:00:00' });
  assert.equal(summary.stillFiring.length, 0);
  assert.equal(summary.cleared.length, 0);
});
