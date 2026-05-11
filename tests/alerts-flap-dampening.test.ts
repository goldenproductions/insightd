import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { processAlerts } = require('../hub/src/alerts/evaluator');

const cfg = (overrides: any = {}) => ({
  smtp: { host: '', port: 0, user: '', pass: '', from: '' },
  alerts: {
    cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440,
    mailCriticalOnly: false, suppressDependents: false,
    flapStabilizeMinutes: 5, diskCriticalPercent: 95,
    ...overrides,
  },
});

function shiftClock(db: any, minutes: number) {
  db.exec(`UPDATE alert_state SET
    triggered_at = datetime(triggered_at, '-${minutes} minutes'),
    last_notified = datetime(last_notified, '-${minutes} minutes'),
    pending_since = CASE WHEN pending_since IS NULL THEN NULL ELSE datetime(pending_since, '-${minutes} minutes') END,
    resolved_pending_since = CASE WHEN resolved_pending_since IS NULL THEN NULL ELSE datetime(resolved_pending_since, '-${minutes} minutes') END
  `);
}

test('initial trigger does not mail before stabilizeMinutes', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 0, 'should hold first send until stable');
  const row = db.prepare('SELECT pending_since, notify_count FROM alert_state').get() as any;
  assert.ok(row.pending_since);
  assert.equal(row.notify_count, 0);
});

test('initial trigger mails after stabilizeMinutes elapse', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 1);
  assert.equal(toSend[0].reminderNumber, 0);
});

test('flap that resolves before stabilize emits no mail', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 2);
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  const toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 0);
  const row = db.prepare("SELECT COUNT(*) AS n FROM alert_state WHERE resolved_at IS NULL").get() as any;
  assert.equal(row.n, 0, 'unmailed flap should be deleted');
});

test('resolution mail held until stabilize then sent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  processAlerts(db, cfg(), { triggered, resolved: [] });  // initial mail
  shiftClock(db, 1);
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  let toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 0, 'resolution should hold for stabilize');
  shiftClock(db, 6);
  toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 1);
  assert.equal(toSend[0].isResolution, true);
});

test('flapStabilizeMinutes=0 sends immediately (back-compat)', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  const toSend = processAlerts(db, cfg({ flapStabilizeMinutes: 0 }), { triggered, resolved: [] });
  assert.equal(toSend.length, 1);
});

test('retrigger inside stabilize window does not double-mail', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  processAlerts(db, cfg(), { triggered, resolved: [] });   // initial mail
  shiftClock(db, 1);
  // resolution observed
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  processAlerts(db, cfg(), { triggered: [], resolved });   // resolution pending
  shiftClock(db, 2);
  // retriggered before resolution stabilizes
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 0);
  const row = db.prepare('SELECT resolved_pending_since FROM alert_state').get() as any;
  assert.equal(row.resolved_pending_since, null, 'resolved_pending_since should clear on retrigger');
});
