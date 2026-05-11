import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Readable } from 'stream';
const { bootstrap } = require('../hub/src/db/schema');
const { handleGetAlertRules, handlePutAlertRule, handleResetAlertRules, handleMuteAlertType } = require('../hub/src/web/handlers');
const { signMuteToken } = require('../hub/src/alerts/mute-token');

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as any, body: '', writableEnded: false };
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.writeHead = (code: number) => { res.statusCode = code; };
  res.end = (b: string) => { res.body = b; res.writableEnded = true; };
  return res;
}

function fakeReqWithBody(method: string, url: string, body: any) {
  const stream: any = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = { 'content-type': 'application/json' };
  return stream;
}

function fakeReq(method: string, url: string) {
  const stream: any = Readable.from([]);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

test('GET /api/alert-rules returns seeded rows with descriptions', async () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  const result = await handleGetAlertRules(fakeReq('GET', '/api/alert-rules'), res, db);
  const body = result ?? JSON.parse(res.body);
  assert.ok(Array.isArray(body.rules));
  assert.ok(body.rules.length >= 27);
  const host = body.rules.find((r: any) => r.alert_type === 'host_offline');
  assert.ok(host.description);
});

test('PUT /api/alert-rules/:type updates the row', async () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  await handlePutAlertRule(fakeReqWithBody('PUT', '/api/alert-rules/host_offline', { mail: 0 }), res, db, null, { type: 'host_offline' });
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='host_offline'").get() as any;
  assert.equal(row.mail, 0);
});

test('POST /api/alert-rules/reset reseeds', async () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare("UPDATE alert_rules SET mail=0 WHERE alert_type='host_offline'").run();
  const res = fakeRes();
  await handleResetAlertRules(fakeReq('POST', '/api/alert-rules/reset'), res, db);
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='host_offline'").get() as any;
  assert.equal(row.mail, 1);
});

test('GET /api/alerts/mute?token=… flips mail to 0', async () => {
  process.env.INSIGHTD_MUTE_SECRET = 'api-test-secret';
  const db = new Database(':memory:'); bootstrap(db);
  const token = signMuteToken('restart_loop');
  const res = fakeRes();
  await handleMuteAlertType(fakeReq('GET', `/api/alerts/mute?token=${encodeURIComponent(token)}`), res, db);
  assert.equal(res.statusCode, 200);
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='restart_loop'").get() as any;
  assert.equal(row.mail, 0);
});

test('GET /api/alerts/mute with invalid token returns 400', async () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  await handleMuteAlertType(fakeReq('GET', '/api/alerts/mute?token=garbage'), res, db);
  assert.equal(res.statusCode, 400);
});
