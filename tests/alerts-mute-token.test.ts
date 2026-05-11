import { test } from 'node:test';
import assert from 'node:assert/strict';
const { signMuteToken, verifyMuteToken } = require('../hub/src/alerts/mute-token');

test('verify accepts a signed token', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  const tok = signMuteToken('restart_loop');
  const result = verifyMuteToken(tok);
  assert.equal(result, 'restart_loop');
});

test('verify rejects tampered tokens', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  const tok = signMuteToken('restart_loop');
  const tampered = tok.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a'));
  assert.equal(verifyMuteToken(tampered), null);
});

test('verify rejects unsigned strings', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  assert.equal(verifyMuteToken('not-a-token'), null);
});

test('verify rejects expired tokens (>30 days)', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS = String(-31 * 24 * 3600 * 1000);
  const tok = signMuteToken('restart_loop');
  delete process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS;
  assert.equal(verifyMuteToken(tok), null);
});
