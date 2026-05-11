import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { runAlerts } = require('../hub/src/alerts/evaluator');
const { updateRule } = require('../hub/src/alerts/rules');

// Hijack sendAlert / dispatchAlertWebhooks via require cache so tests can
// observe what would be dispatched.
function withSpies(fn: (counts: { mails: any[]; hooks: any[] }) => Promise<void>) {
  const senderPath = require.resolve('../hub/src/alerts/sender');
  const webhooksPath = require.resolve('../shared/webhooks/sender');
  const origSender = require(senderPath);
  const origHooks = require(webhooksPath);
  const counts = { mails: [] as any[], hooks: [] as any[] };
  require.cache[senderPath]!.exports = { ...origSender,
    sendAlert: async (alert: any) => { counts.mails.push(alert); },
    sendAftermath: async () => {}
  };
  require.cache[webhooksPath]!.exports = { ...origHooks,
    dispatchAlertWebhooks: async (_db: any, a: any) => { counts.hooks.push(a); }
  };
  return fn(counts).finally(() => {
    require.cache[senderPath]!.exports = origSender;
    require.cache[webhooksPath]!.exports = origHooks;
  });
}

function fakeContainerDown(db: any) {
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  db.prepare(`INSERT INTO container_snapshots (host_id, container_name, container_id, status, exit_code, collected_at) VALUES
    ('h1', 'nginx', 'cid1', 'running', NULL, datetime('now', '-1 minutes')),
    ('h1', 'nginx', 'cid1', 'exited', 1, datetime('now'))`).run();
}

test('warning alert with mailCriticalOnly=true does not mail', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { severity: 'warning' });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1, 'webhook should still fire');
  });
});

test('critical alert with mail=0 does not mail but webhooks', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { mail: 0 });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1);
  });
});

test('enabled=0 fires neither channel', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { enabled: 0 });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: false, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 0);
  });
});

test('disk_full below diskCriticalPercent downgrades to warning, no mail', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    db.prepare(`INSERT INTO disk_snapshots (host_id, mount_point, used_percent, used_gb, total_gb, collected_at)
                VALUES ('h1', '/', 91, 91, 100, datetime('now'))`).run();
    const cfg = { alerts: { enabled: true, diskPercent: 90, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1);
  });
});

test('disk_full at/over diskCriticalPercent mails', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    db.prepare(`INSERT INTO disk_snapshots (host_id, mount_point, used_percent, used_gb, total_gb, collected_at)
                VALUES ('h1', '/', 96, 96, 100, datetime('now'))`).run();
    const cfg = { alerts: { enabled: true, diskPercent: 90, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 1);
  });
});
