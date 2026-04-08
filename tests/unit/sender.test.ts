import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const nodemailer = require('nodemailer');
const { GREEN_DIGEST } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');

describe('sendDigest', () => {
  let sendDigest: Function;
  let restore: () => void;
  let mockTransport: any;

  beforeEach(() => {
    restore = suppressConsole();
    mockTransport = { sendMail: mock.fn(async () => ({ messageId: 'test-123' })) };
    mock.method(nodemailer, 'createTransport', () => mockTransport);
    delete require.cache[require.resolve('../../src/digest/sender')];
    sendDigest = require('../../src/digest/sender').sendDigest;
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
  });

  it('skips when SMTP host is empty', async () => {
    const config = { smtp: { host: '', port: 587, user: '', pass: '', from: '' }, digestTo: 'test@test.com' };
    await sendDigest(GREEN_DIGEST, config);
    assert.equal(mockTransport.sendMail.mock.calls.length, 0);
  });

  it('skips when digestTo is empty', async () => {
    const config = { smtp: { host: 'smtp.test.com', port: 587, user: 'u', pass: 'p', from: 'f' }, digestTo: '' };
    await sendDigest(GREEN_DIGEST, config);
    assert.equal(mockTransport.sendMail.mock.calls.length, 0);
  });

  it('creates transport with correct SMTP config', async () => {
    const config = {
      smtp: { host: 'smtp.test.com', port: 465, user: 'user@test.com', pass: 'secret', from: 'from@test.com' },
      digestTo: 'to@test.com',
    };
    await sendDigest(GREEN_DIGEST, config);

    const call = nodemailer.createTransport.mock.calls[0];
    assert.equal(call.arguments[0].host, 'smtp.test.com');
    assert.equal(call.arguments[0].port, 465);
    assert.equal(call.arguments[0].secure, true); // port 465 = secure
  });

  it('sends email with correct recipient and subject', async () => {
    const config = {
      smtp: { host: 'smtp.test.com', port: 587, user: 'u', pass: 'p', from: 'from@test.com' },
      digestTo: 'to@test.com',
    };
    await sendDigest(GREEN_DIGEST, config);

    const mailOpts = mockTransport.sendMail.mock.calls[0].arguments[0];
    assert.equal(mailOpts.to, 'to@test.com');
    assert.equal(mailOpts.from, 'from@test.com');
    assert.match(mailOpts.subject, /Week 14/);
    assert.match(mailOpts.subject, /🟢/);
  });

  it('includes both HTML and plaintext body', async () => {
    const config = {
      smtp: { host: 'smtp.test.com', port: 587, user: 'u', pass: 'p', from: 'f' },
      digestTo: 'to@test.com',
    };
    await sendDigest(GREEN_DIGEST, config);

    const mailOpts = mockTransport.sendMail.mock.calls[0].arguments[0];
    assert.ok(mailOpts.html.includes('<!DOCTYPE html>'));
    assert.ok(mailOpts.text.includes('Insightd'));
  });
});
