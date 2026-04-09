import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const crypto = require('crypto');
const { createTestDb } = require('../helpers/db');

// Force a fresh module instance per test (auth.ts has module-level _db, sessionCache, failedAttempts).
function loadAuth(): any {
  delete require.cache[require.resolve('../../hub/src/web/auth')];
  return require('../../hub/src/web/auth');
}

function setAdminPassword(db: any, password: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin.password', ?, datetime('now'))").run(password);
}

describe('hub/web/auth', () => {
  let db: any;
  let auth: any;

  beforeEach(() => {
    db = createTestDb();
    auth = loadAuth();
    auth.setDb(db);
    delete process.env.INSIGHTD_ADMIN_PASSWORD;
  });

  afterEach(() => {
    db.close();
  });

  describe('isAuthEnabled / isSetupComplete', () => {
    it('isAuthEnabled returns false when no admin password is set', () => {
      assert.equal(auth.isAuthEnabled(), false);
    });

    it('isAuthEnabled returns true when admin password is in settings', () => {
      setAdminPassword(db, 'hunter2');
      assert.equal(auth.isAuthEnabled(), true);
    });

    it('isAuthEnabled returns true when INSIGHTD_ADMIN_PASSWORD env var is set', () => {
      process.env.INSIGHTD_ADMIN_PASSWORD = 'env-password';
      assert.equal(auth.isAuthEnabled(), true);
    });

    it('isSetupComplete reflects the meta flag', () => {
      assert.equal(auth.isSetupComplete(), false);
      db.prepare("INSERT INTO meta (key, value) VALUES ('setup_complete', 'true')").run();
      assert.equal(auth.isSetupComplete(), true);
    });
  });

  describe('authenticate', () => {
    beforeEach(() => { setAdminPassword(db, 'hunter2'); });

    it('returns null when password is wrong', () => {
      assert.equal(auth.authenticate('wrong'), null);
    });

    it('returns a 64-char hex token on correct password', () => {
      const token = auth.authenticate('hunter2');
      assert.ok(token);
      assert.match(token, /^[a-f0-9]{64}$/);
    });

    it('persists the session token to the sessions table', () => {
      const token = auth.authenticate('hunter2');
      const row = db.prepare('SELECT token FROM sessions WHERE token = ?').get(token);
      assert.ok(row, 'session row should exist');
    });

    it('rejects mismatched-length passwords (timing-safe path)', () => {
      // Same characters but a different length — must not crash and must return null
      assert.equal(auth.authenticate('hunter2hunter2'), null);
      assert.equal(auth.authenticate(''), null);
    });

    it('locks out an IP after 5 failed attempts within the window', () => {
      const ip = '10.0.0.99';
      for (let i = 0; i < 5; i++) auth.authenticate('wrong', ip);
      // 6th attempt with the right password should still fail because of lockout
      assert.equal(auth.authenticate('hunter2', ip), null);
    });

    it('clears failed attempts on successful login', () => {
      const ip = '10.0.0.100';
      auth.authenticate('wrong', ip);
      auth.authenticate('wrong', ip);
      // Successful login resets the counter
      const token = auth.authenticate('hunter2', ip);
      assert.ok(token);
      // Now 3 more wrongs would be needed before lockout — verify a single wrong doesn't lock us out
      auth.authenticate('wrong', ip);
      assert.ok(auth.authenticate('hunter2', ip), 'should still authenticate after a single fail post-success');
    });
  });

  describe('validateToken / requireAuth', () => {
    beforeEach(() => { setAdminPassword(db, 'hunter2'); });

    it('validateToken accepts a freshly issued session token', () => {
      const token = auth.authenticate('hunter2');
      assert.equal(auth.validateToken(token), true);
    });

    it('validateToken rejects an unknown token', () => {
      assert.equal(auth.validateToken('not-a-real-token'), false);
    });

    it('validateToken rejects an empty token', () => {
      assert.equal(auth.validateToken(''), false);
    });

    it('logout removes the session', () => {
      const token = auth.authenticate('hunter2');
      assert.equal(auth.validateToken(token), true);
      auth.logout(token);
      assert.equal(auth.validateToken(token), false);
      // Also gone from DB
      const row = db.prepare('SELECT token FROM sessions WHERE token = ?').get(token);
      assert.equal(row, undefined);
    });

    it('requireAuth returns true when auth is disabled (no admin password)', () => {
      // Clear the password — auth disabled mode
      db.prepare("DELETE FROM settings WHERE key = 'admin.password'").run();
      const req = { headers: {} } as any;
      assert.equal(auth.requireAuth(req), true);
    });

    it('requireAuth checks Bearer token when auth is enabled', () => {
      const token = auth.authenticate('hunter2');
      const goodReq = { headers: { authorization: `Bearer ${token}` } } as any;
      const badReq = { headers: { authorization: 'Bearer not-a-token' } } as any;
      const noHeader = { headers: {} } as any;
      assert.equal(auth.requireAuth(goodReq), true);
      assert.equal(auth.requireAuth(badReq), false);
      assert.equal(auth.requireAuth(noHeader), false);
    });
  });

  describe('API keys', () => {
    it('createApiKey returns an insightd_-prefixed key and stores its hash', () => {
      const { key, prefix } = auth.createApiKey(db, 'CI Bot');
      assert.match(key, /^insightd_[a-f0-9]{40}$/);
      assert.equal(prefix.length, 17);
      assert.ok(key.startsWith(prefix));

      const row = db.prepare('SELECT name, key_prefix, key_hash FROM api_keys').get();
      assert.equal(row.name, 'CI Bot');
      assert.equal(row.key_prefix, prefix);
      // Stored hash matches sha256(key)
      const expectedHash = crypto.createHash('sha256').update(key).digest('hex');
      assert.equal(row.key_hash, expectedHash);
    });

    it('validateToken accepts an API key', () => {
      const { key } = auth.createApiKey(db, 'CI Bot');
      assert.equal(auth.validateToken(key), true);
    });

    it('validateToken rejects a malformed insightd_ key', () => {
      assert.equal(auth.validateToken('insightd_deadbeef'), false);
    });

    it('validateToken updates last_used_at when accepting an API key', () => {
      const { key } = auth.createApiKey(db, 'CI Bot');
      assert.equal(db.prepare('SELECT last_used_at FROM api_keys').get().last_used_at, null);
      auth.validateToken(key);
      const row = db.prepare('SELECT last_used_at FROM api_keys').get();
      assert.ok(row.last_used_at, 'last_used_at should be set');
    });

    it('revokeApiKey removes the row and rejects subsequent validation', () => {
      const { key } = auth.createApiKey(db, 'CI Bot');
      const id = (db.prepare('SELECT id FROM api_keys').get() as any).id;
      assert.equal(auth.validateToken(key), true);
      auth.revokeApiKey(db, id);
      assert.equal(auth.validateToken(key), false);
      assert.equal(db.prepare('SELECT COUNT(*) as c FROM api_keys').get().c, 0);
    });

    it('getApiKeys returns all keys without exposing the hash', () => {
      auth.createApiKey(db, 'A');
      auth.createApiKey(db, 'B');
      const keys = auth.getApiKeys(db);
      assert.equal(keys.length, 2);
      // Should NOT include the hash field
      assert.ok(!('key_hash' in keys[0]));
      assert.ok(keys[0].key_prefix);
    });
  });
});
