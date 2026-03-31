const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedWebhooks } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const queries = require('../../shared/webhooks/queries');

describe('webhook queries', () => {
  let db, restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  it('should create and retrieve a webhook', () => {
    const { id } = queries.createWebhook(db, { name: 'Slack', type: 'slack', url: 'https://hooks.slack.com/xxx' });
    const wh = queries.getWebhook(db, id);
    assert.equal(wh.name, 'Slack');
    assert.equal(wh.type, 'slack');
    assert.equal(wh.on_alert, 1);
    assert.equal(wh.on_digest, 1);
    assert.equal(wh.enabled, 1);
  });

  it('should list webhooks sorted by name', () => {
    queries.createWebhook(db, { name: 'Zebra', type: 'generic', url: 'https://z.com' });
    queries.createWebhook(db, { name: 'Alpha', type: 'slack', url: 'https://a.com' });
    const all = queries.getWebhooks(db);
    assert.equal(all.length, 2);
    assert.equal(all[0].name, 'Alpha');
  });

  it('should filter enabled webhooks by purpose', () => {
    queries.createWebhook(db, { name: 'Alert Only', type: 'slack', url: 'https://a.com', onDigest: false });
    queries.createWebhook(db, { name: 'Digest Only', type: 'slack', url: 'https://d.com', onAlert: false });
    queries.createWebhook(db, { name: 'Disabled', type: 'slack', url: 'https://x.com', enabled: false });

    const alertHooks = queries.getEnabledWebhooks(db, { onAlert: true });
    assert.equal(alertHooks.length, 1);
    assert.equal(alertHooks[0].name, 'Alert Only');

    const digestHooks = queries.getEnabledWebhooks(db, { onDigest: true });
    assert.equal(digestHooks.length, 1);
    assert.equal(digestHooks[0].name, 'Digest Only');
  });

  it('should update specific fields', () => {
    const { id } = queries.createWebhook(db, { name: 'Test', type: 'slack', url: 'https://old.com' });
    queries.updateWebhook(db, id, { name: 'Updated', url: 'https://new.com' });
    const wh = queries.getWebhook(db, id);
    assert.equal(wh.name, 'Updated');
    assert.equal(wh.url, 'https://new.com');
    assert.equal(wh.type, 'slack'); // unchanged
  });

  it('should delete a webhook', () => {
    const { id } = queries.createWebhook(db, { name: 'Test', type: 'slack', url: 'https://t.com' });
    const result = queries.deleteWebhook(db, id);
    assert.equal(result.deleted, true);
    assert.equal(queries.getWebhook(db, id), null);
  });

  it('should return deleted false for non-existent', () => {
    const result = queries.deleteWebhook(db, 999);
    assert.equal(result.deleted, false);
  });
});
