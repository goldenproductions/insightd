import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const nodemailer = require('nodemailer');
const { suppressConsole } = require('../helpers/mocks');
const { subjectFor, renderAlertText, renderAlertHtml } = require('../../shared/mail/alert-template');

describe('alert sender', () => {
  let sendAlert: Function;
  let restore: () => void;
  let mockTransport: any;

  beforeEach(() => {
    restore = suppressConsole();
    mockTransport = { sendMail: mock.fn(async () => ({ messageId: 'alert-123' })) };
    mock.method(nodemailer, 'createTransport', () => mockTransport);
    delete require.cache[require.resolve('../../src/alerts/sender')];
    const mod = require('../../src/alerts/sender');
    sendAlert = mod.sendAlert;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  const config = {
    smtp: { host: 'smtp.test.com', port: 587, user: 'u', pass: 'p', from: 'from@test.com' },
    alerts: { to: 'to@test.com' },
  };

  describe('subjectFor', () => {
    it('formats trigger subject', () => {
      const subject = subjectFor({ message: 'nginx is down', reminderNumber: 0 });
      assert.equal(subject, '[ALERT] insightd: nginx is down');
    });

    it('formats resolution subject', () => {
      const subject = subjectFor({ message: 'nginx is running again', isResolution: true });
      assert.equal(subject, '[OK] insightd: nginx is running again');
    });

    it('formats reminder subject', () => {
      const subject = subjectFor({ message: 'nginx is down', reminderNumber: 2 });
      assert.equal(subject, '[ALERT] insightd: nginx is down (reminder #2)');
    });
  });

  describe('renderAlertText', () => {
    it('includes alert details', () => {
      const body = renderAlertText({ type: 'container_down', target: 'nginx', message: 'nginx is down', value: 'exited' });
      assert.match(body, /ALERT: nginx is down/);
      assert.match(body, /Target:.*nginx/);
      assert.match(body, /Type:.*Container down/i);
    });

    it('includes resolution details', () => {
      const body = renderAlertText({ message: 'nginx is running again', isResolution: true, triggeredAt: '2026-03-30 10:00:00' });
      assert.match(body, /RESOLVED: nginx is running again/);
      assert.match(body, /Was alerting since/);
    });

    it('surfaces diagnosis evidence + suggested action when available', () => {
      const body = renderAlertText(
        { type: 'container_unhealthy', target: 'adguard', hostId: 'host-1', message: 'adguard is unhealthy' },
        {
          diagnosis: {
            title: 'Zombie listener',
            message: 'Container accepts connections but refuses them.',
            severity: 'warning',
            confidence: 'high',
            suggested_action: 'Restart the container to re-initialise its listener.',
            evidence: JSON.stringify(['Connection refused on :53', 'Stable memory', 'No restarts in 2h']),
          },
        },
      );
      assert.match(body, /Why this is alerting/);
      assert.match(body, /Zombie listener/);
      assert.match(body, /Restart the container/);
      assert.match(body, /Connection refused on :53/);
      assert.match(body, /Confidence: high/);
    });

    it('renders Open in Insightd link when baseUrl provided', () => {
      const body = renderAlertText(
        { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' },
        { baseUrl: 'https://insightd.example.com' },
      );
      // Validate the rendered link by parsing it out and checking the URL
      // components explicitly rather than substring-matching the assembled URL.
      const match = body.match(/Open in Insightd: (\S+)/);
      assert.ok(match, 'body should contain an Open in Insightd link');
      const url = new URL(match![1]);
      assert.equal(url.hostname, 'insightd.example.com');
      assert.equal(url.pathname, '/containers/host-1/nginx');
    });
  });

  describe('renderAlertHtml', () => {
    it('produces an email-safe HTML document', () => {
      const html = renderAlertHtml({ type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' });
      assert.match(html, /<!DOCTYPE html>/);
      assert.ok(!/<style\b/i.test(html));
      assert.ok(!/<script\b/i.test(html));
    });

    it('uses red severity color for container_down', () => {
      const html = renderAlertHtml({ type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' });
      assert.match(html, /#dc2626/);
    });

    it('uses green severity color for resolutions', () => {
      const html = renderAlertHtml({ type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is up', isResolution: true });
      assert.match(html, /#059669/);
    });

    it('renders the Why this is alerting card when diagnosis is provided', () => {
      const html = renderAlertHtml(
        { type: 'container_unhealthy', target: 'adguard', hostId: 'host-1', message: 'adguard is unhealthy' },
        {
          diagnosis: {
            title: 'Zombie listener',
            message: 'Container accepts connections but refuses them.',
            severity: 'warning',
            confidence: 'high',
            suggested_action: 'Restart the container to re-initialise its listener.',
            evidence: JSON.stringify(['Connection refused on :53', 'Stable memory']),
          },
        },
      );
      assert.match(html, /Why this is alerting/);
      assert.match(html, /Zombie listener/);
      assert.match(html, /Restart the container/);
      assert.match(html, /Connection refused on :53/);
    });

    it('omits the diagnosis card when diagnosis is null', () => {
      const html = renderAlertHtml(
        { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' },
        { diagnosis: null },
      );
      assert.ok(!/Why this is alerting/.test(html));
    });

    it('renders Open in Insightd button when baseUrl provided', () => {
      const html = renderAlertHtml(
        { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' },
        { baseUrl: 'https://insightd.example.com' },
      );
      assert.match(html, /Open in Insightd/);
      // Parse the button href and validate URL components explicitly.
      const hrefMatch = html.match(/href="([^"]*\/containers\/[^"]*)"/);
      assert.ok(hrefMatch, 'html should contain a container link');
      const url = new URL(hrefMatch![1]);
      assert.equal(url.hostname, 'insightd.example.com');
      assert.equal(url.pathname, '/containers/host-1/nginx');
    });

    it('omits Open in Insightd button when baseUrl empty', () => {
      const html = renderAlertHtml(
        { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down' },
        { baseUrl: '' },
      );
      assert.ok(!/Open in Insightd/.test(html));
    });
  });

  describe('sendAlert', () => {
    it('sends email with correct subject, recipient, and both text + html', async () => {
      const alert = { type: 'container_down', target: 'nginx', hostId: 'host-1', message: 'nginx is down', value: 'exited', reminderNumber: 0 };
      await sendAlert(alert, config);

      assert.equal(mockTransport.sendMail.mock.calls.length, 1);
      const mailOpts = mockTransport.sendMail.mock.calls[0].arguments[0];
      assert.equal(mailOpts.to, 'to@test.com');
      assert.match(mailOpts.subject, /\[ALERT\]/);
      assert.ok(mailOpts.text && mailOpts.text.length > 0, 'plaintext body should be set');
      assert.ok(mailOpts.html && mailOpts.html.includes('<!DOCTYPE html>'), 'html body should be a full document');
    });

    it('skips when SMTP not configured', async () => {
      const noSmtp = { smtp: { host: '' }, alerts: { to: 'test@test.com' } };
      await sendAlert({ message: 'test' }, noSmtp);
      assert.equal(mockTransport.sendMail.mock.calls.length, 0);
    });
  });
});
