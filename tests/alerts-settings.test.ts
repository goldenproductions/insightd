import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { getEffectiveConfig, SETTING_DEFS } = require('../hub/src/db/settings');

test('SETTING_DEFS includes the four new mail-strategy keys', () => {
  const keys = new Set(SETTING_DEFS.map((d: any) => d.key));
  assert.ok(keys.has('alerts.mailCriticalOnly'));
  assert.ok(keys.has('alerts.suppressDependents'));
  assert.ok(keys.has('alerts.flapStabilizeMinutes'));
  assert.ok(keys.has('alerts.diskCriticalPercent'));
});

test('default values from getEffectiveConfig', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const cfg = getEffectiveConfig(db, { alerts: {} });
  assert.equal(cfg.alerts.mailCriticalOnly, true);
  assert.equal(cfg.alerts.suppressDependents, true);
  assert.equal(cfg.alerts.flapStabilizeMinutes, 5);
  assert.equal(cfg.alerts.diskCriticalPercent, 95);
});

test('overrides via settings table', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('alerts.mailCriticalOnly', 'false');
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('alerts.flapStabilizeMinutes', '0');
  const cfg = getEffectiveConfig(db, { alerts: {} });
  assert.equal(cfg.alerts.mailCriticalOnly, false);
  assert.equal(cfg.alerts.flapStabilizeMinutes, 0);
});
