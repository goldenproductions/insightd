import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const nodemailer = require('nodemailer');
const { suppressConsole } = require('../helpers/mocks');

describe('alert sender', () => {
  let sendAlert: Function, formatSubject: Function, formatBody: Function;
  let restore: () => void;
  let mockTransport: any;

  beforeEach(() => {
    restore = suppressConsole();
    mockTransport = { sendMail: mock.fn(async () => ({ messageId: 'alert-123' })) };
    mock.method(nodemailer, 'createTransport', () => mockTransport);
    delete require.cache[require.resolve('../../src/alerts/sender')];
    const mod = require('../../src/alerts/sender');
    sendAlert = mod.sendAlert;
    formatSubject = mod.formatSubject;
    formatBody = mod.formatBody;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  const config = {
    smtp: { host: 'smtp.test.com', port: 587, user: 'u', pass: 'p', from: 'from@test.com' },
    alerts: { to: 'to@test.com' },
  };

  describe('formatSubject', () => {
    it('formats trigger subject', () => {
      const subject = formatSubject({ message: 'nginx is down', reminderNumber: 0 });
      assert.equal(subject, '[ALERT] insightd: nginx is down');
    });

    it('formats resolution subject', () => {
      const subject = formatSubject({ message: 'nginx is running again', isResolution: true });
      assert.equal(subject, '[OK] insightd: nginx is running again');
    });

    it('formats reminder subject', () => {
      const subject = formatSubject({ message: 'nginx is down', reminderNumber: 2 });
      assert.equal(subject, '[ALERT] insightd: nginx is down (reminder #2)');
    });
  });

  describe('formatBody', () => {
    it('includes alert details', () => {
      const body = formatBody({ type: 'container_down', target: 'nginx', message: 'nginx is down', value: 'exited' });
      assert.match(body, /ALERT: nginx is down/);
      assert.match(body, /Target:.*nginx/);
      assert.match(body, /Type:.*container_down/);
    });

    it('includes resolution details', () => {
      const body = formatBody({ message: 'nginx is running again', isResolution: true, triggeredAt: '2026-03-30 10:00:00' });
      assert.match(body, /RESOLVED: nginx is running again/);
      assert.match(body, /Was alerting since/);
    });
  });

  describe('sendAlert', () => {
    it('sends email with correct subject and recipient', async () => {
      const alert = { type: 'container_down', target: 'nginx', message: 'nginx is down', value: 'exited', reminderNumber: 0 };
      await sendAlert(alert, config);

      assert.equal(mockTransport.sendMail.mock.calls.length, 1);
      const mailOpts = mockTransport.sendMail.mock.calls[0].arguments[0];
      assert.equal(mailOpts.to, 'to@test.com');
      assert.match(mailOpts.subject, /\[ALERT\]/);
      assert.ok(mailOpts.text.length > 0);
      assert.equal(mailOpts.html, undefined); // plain text only
    });

    it('skips when SMTP not configured', async () => {
      const noSmtp = { smtp: { host: '' }, alerts: { to: 'test@test.com' } };
      await sendAlert({ message: 'test' }, noSmtp);
      assert.equal(mockTransport.sendMail.mock.calls.length, 0);
    });
  });
});
