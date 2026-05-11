import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { getRule, getAllRules, updateRule, resetRules, ensureRulesSeeded } = require('../hub/src/alerts/rules');

function freshDb() {
  const db = new Database(':memory:');
  bootstrap(db);
  return db;
}

test('getRule returns seeded row', () => {
  const db = freshDb();
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
  assert.equal(r.enabled, 1);
});

test('getRule returns synthetic row for unknown type (defaults from static map)', () => {
  const db = freshDb();
  db.prepare("DELETE FROM alert_rules WHERE alert_type = 'host_offline'").run();
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
});

test('getRule returns warning fallback for unmapped type', () => {
  const db = freshDb();
  const r = getRule(db, 'totally_new_alert_type');
  assert.equal(r.severity, 'warning');
  assert.equal(r.mail, 0);
});

test('getAllRules returns sorted list with descriptions', () => {
  const db = freshDb();
  const rows = getAllRules(db);
  assert.ok(rows.length >= 27);
  for (const r of rows) {
    assert.ok(r.description, `${r.alert_type} missing description`);
  }
  // sorted by alert_type
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].alert_type >= rows[i - 1].alert_type);
  }
});

test('updateRule changes one field only', () => {
  const db = freshDb();
  updateRule(db, 'restart_loop', { mail: 1 });
  const r = getRule(db, 'restart_loop');
  assert.equal(r.mail, 1);
  assert.equal(r.severity, 'warning');
  assert.equal(r.enabled, 1);
});

test('updateRule rejects unknown severity', () => {
  const db = freshDb();
  assert.throws(() => updateRule(db, 'restart_loop', { severity: 'fatal' as any }));
});

test('resetRules wipes overrides and reseeds', () => {
  const db = freshDb();
  updateRule(db, 'restart_loop', { mail: 1, severity: 'critical' });
  resetRules(db);
  const r = getRule(db, 'restart_loop');
  assert.equal(r.severity, 'warning');
  assert.equal(r.mail, 0);
});

test('ensureRulesSeeded adds rows for new alert types', () => {
  const db = freshDb();
  db.prepare("DELETE FROM alert_rules WHERE alert_type = 'host_offline'").run();
  ensureRulesSeeded(db);
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
});
