import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');

test('alert_rules table exists after bootstrap and is seeded', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  const rows = db.prepare('SELECT alert_type, severity, enabled, mail, webhook FROM alert_rules ORDER BY alert_type').all();
  assert.ok(rows.length >= 27, `expected at least 27 seeded rules, got ${rows.length}`);
  const host = rows.find((r: any) => r.alert_type === 'host_offline');
  assert.deepEqual(host, { alert_type: 'host_offline', severity: 'critical', enabled: 1, mail: 1, webhook: 1 });
  const restart = rows.find((r: any) => r.alert_type === 'restart_loop');
  assert.deepEqual(restart, { alert_type: 'restart_loop', severity: 'warning', enabled: 1, mail: 0, webhook: 1 });
});

test('alert_state has the four new columns', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  const cols = db.prepare("PRAGMA table_info(alert_state)").all() as { name: string }[];
  const names = new Set(cols.map(c => c.name));
  assert.ok(names.has('severity'), 'severity column missing');
  assert.ok(names.has('pending_since'), 'pending_since column missing');
  assert.ok(names.has('resolved_pending_since'), 'resolved_pending_since column missing');
  assert.ok(names.has('suppressed_by_state_id'), 'suppressed_by_state_id column missing');
});

test('migration from v51 backfills pending_since and severity', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  db.prepare("UPDATE meta SET value = '51' WHERE key = 'schema_version'").run();
  db.exec(`
    DROP TABLE alert_rules;
    CREATE TABLE alert_state_old AS SELECT * FROM alert_state;
    DROP TABLE alert_state;
    CREATE TABLE alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL DEFAULT 'local',
      alert_type TEXT NOT NULL,
      target TEXT NOT NULL,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      last_notified TEXT NOT NULL DEFAULT (datetime('now')),
      notify_count INTEGER DEFAULT 1,
      message TEXT, trigger_value TEXT, threshold TEXT,
      silenced_until TEXT, silenced_by TEXT, silenced_at TEXT
    );
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message)
      VALUES ('h1', 'host_offline', 'system', '2026-05-11 10:00:00', '2026-05-11 10:00:00', 1, 'down');
  `);
  bootstrap(db);  // re-run; should detect old version and migrate
  const row = db.prepare("SELECT severity, pending_since FROM alert_state WHERE alert_type = 'host_offline'").get() as any;
  assert.equal(row.severity, 'critical');
  assert.equal(row.pending_since, '2026-05-11 10:00:00');
});
