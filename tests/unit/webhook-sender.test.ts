import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { suppressConsole } = require('../helpers/mocks');
const { createTestDb, seedWebhooks } = require('../helpers/db');

describe('webhook sender', () => {
  let restore: () => void;

  beforeEach(() => { restore = suppressConsole(); });
  afterEach(() => { restore(); mock.restoreAll(); });

  describe('formatters', () => {
    const alert = { type: 'container_down', hostId: 'local', target: 'nginx', message: 'Container "nginx" is down', value: 'exited', reminderNumber: 0 };
    const resolution = { ...alert, isResolution: true, message: 'Container "nginx" is running again' };

    it('formatSlackAlert produces text with emoji', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatSlackAlert } = require('../../shared/webhooks/sender');
      const result = formatSlackAlert(alert);
      assert.ok(result.text.includes('*[ALERT]*'));
      assert.ok(result.text.includes('nginx'));
    });

    it('formatSlackAlert uses checkmark for resolution', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatSlackAlert } = require('../../shared/webhooks/sender');
      const result = formatSlackAlert(resolution);
      assert.ok(result.text.includes('*[RESOLVED]*'));
    });

    it('formatDiscordAlert produces content', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatDiscordAlert } = require('../../shared/webhooks/sender');
      const result = formatDiscordAlert(alert);
      assert.ok(result.content.includes('**[ALERT]**'));
    });

    it('formatTelegramAlert produces chat_id and HTML', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatTelegramAlert } = require('../../shared/webhooks/sender');
      const result = formatTelegramAlert(alert, '12345');
      assert.equal(result.chat_id, '12345');
      assert.equal(result.parse_mode, 'HTML');
      assert.ok(result.text.includes('<b>[ALERT]</b>'));
    });

    it('formatNtfyAlert produces body and headers', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatNtfyAlert } = require('../../shared/webhooks/sender');
      const result = formatNtfyAlert(alert);
      assert.ok(result.body.includes('nginx'));
      assert.equal(result.headers['X-Priority'], 'high');
      assert.ok(result.headers['X-Title'].includes('ALERT'));
    });

    it('formatGenericAlert includes event field', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { formatGenericAlert } = require('../../shared/webhooks/sender');
      const result = formatGenericAlert(alert);
      assert.equal(result.event, 'alert');
      assert.equal(result.type, 'container_down');
    });
  });

  describe('buildUrl', () => {
    it('constructs Telegram API URL from token', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { buildUrl } = require('../../shared/webhooks/sender');
      assert.equal(buildUrl({ type: 'telegram', url: 'mytoken123' }), 'https://api.telegram.org/botmytoken123/sendMessage');
    });

    it('passes through URL for other types', () => {
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { buildUrl } = require('../../shared/webhooks/sender');
      assert.equal(buildUrl({ type: 'slack', url: 'https://hooks.slack.com/xxx' }), 'https://hooks.slack.com/xxx');
    });
  });

  describe('sendWebhook', () => {
    it('POSTs JSON for non-ntfy types', async () => {
      let receivedOpts: any;
      mock.method(global, 'fetch', async (url: string, opts: any) => {
        receivedOpts = opts;
        return { ok: true, status: 200 };
      });
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { sendWebhook } = require('../../shared/webhooks/sender');

      const result = await sendWebhook(
        { type: 'slack', url: 'https://hooks.slack.com/test', name: 'test' },
        { text: 'hello' }
      );
      assert.equal(result.ok, true);
      assert.equal(receivedOpts.headers['Content-Type'], 'application/json');
    });

    it('POSTs plain text for ntfy with custom headers', async () => {
      let receivedOpts: any;
      mock.method(global, 'fetch', async (url: string, opts: any) => {
        receivedOpts = opts;
        return { ok: true, status: 200 };
      });
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { sendWebhook } = require('../../shared/webhooks/sender');

      await sendWebhook(
        { type: 'ntfy', url: 'https://ntfy.sh/test', name: 'test' },
        { body: 'hello', headers: { 'X-Title': 'Test', 'X-Priority': 'high' } }
      );
      assert.equal(receivedOpts.headers['Content-Type'], 'text/plain');
      assert.equal(receivedOpts.headers['X-Title'], 'Test');
      assert.equal(receivedOpts.body, 'hello');
    });

    it('handles fetch errors gracefully', async () => {
      mock.method(global, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { sendWebhook } = require('../../shared/webhooks/sender');

      const result = await sendWebhook(
        { type: 'slack', url: 'https://fail.com', name: 'fail' },
        { text: 'test' }
      );
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('ECONNREFUSED'));
    });
  });

  describe('dispatchAlertWebhooks', () => {
    it('sends to all enabled alert webhooks', async () => {
      let callCount = 0;
      mock.method(global, 'fetch', async () => { callCount++; return { ok: true, status: 200 }; });
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { dispatchAlertWebhooks } = require('../../shared/webhooks/sender');

      const db = createTestDb();
      seedWebhooks(db, [
        { name: 'Slack', type: 'slack', url: 'https://slack.com/hook' },
        { name: 'ntfy', type: 'ntfy', url: 'https://ntfy.sh/test' },
        { name: 'Disabled', type: 'slack', url: 'https://x.com', enabled: false },
      ]);

      const alert = { type: 'test', hostId: 'local', target: 'test', message: 'test', value: 'test', reminderNumber: 0 };
      const results = await dispatchAlertWebhooks(db, alert);
      assert.equal(results.length, 2);
      assert.equal(callCount, 2);
      db.close();
    });

    it('one failure does not block others', async () => {
      let callCount = 0;
      mock.method(global, 'fetch', async (url: string) => {
        callCount++;
        if (url.includes('fail')) throw new Error('fail');
        return { ok: true, status: 200 };
      });
      delete require.cache[require.resolve('../../shared/webhooks/sender')];
      const { dispatchAlertWebhooks } = require('../../shared/webhooks/sender');

      const db = createTestDb();
      seedWebhooks(db, [
        { name: 'Fail', type: 'generic', url: 'https://fail.com' },
        { name: 'Success', type: 'generic', url: 'https://success.com' },
      ]);

      const alert = { type: 'test', hostId: 'local', target: 'test', message: 'test', value: 'test', reminderNumber: 0 };
      const results = await dispatchAlertWebhooks(db, alert);
      assert.equal(results.length, 2);
      assert.equal(callCount, 2);
      assert.equal(results[0].ok, false);
      assert.equal(results[1].ok, true);
      db.close();
    });
  });
});
