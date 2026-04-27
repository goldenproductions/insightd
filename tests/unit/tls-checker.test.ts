import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHttpEndpoints } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const { probeTls, runTlsChecks } = require('../../hub/src/http-monitor/tlsChecker');

describe('tlsChecker — URL handling + persistence', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
    restore();
  });

  it('probeTls returns not-https for http URLs', async () => {
    const r = await probeTls('http://example.com');
    assert.equal(r.error, 'not-https');
    assert.equal(r.expiresAt, null);
  });

  it('probeTls returns not-https for malformed URLs', async () => {
    const r = await probeTls('not a url');
    assert.equal(r.error, 'not-https');
  });

  it('runTlsChecks skips http endpoints (no probe attempted)', async () => {
    seedHttpEndpoints(db, [{ name: 'plain', url: 'http://localhost' }]);
    await runTlsChecks(db, 6);
    const row = db.prepare(`SELECT tls_last_checked_at, tls_expires_at FROM http_endpoints WHERE name = 'plain'`).get();
    assert.equal(row.tls_last_checked_at, null);
    assert.equal(row.tls_expires_at, null);
  });

  it('runTlsChecks clears stale TLS fields when an endpoint flips https → http', async () => {
    seedHttpEndpoints(db, [{ name: 'switched', url: 'http://localhost' }]);
    db.prepare(`
      UPDATE http_endpoints
         SET tls_expires_at = ?, tls_issuer = 'Old CA', tls_subject_alt_names = 'a,b',
             tls_last_checked_at = ?, tls_error = NULL
       WHERE name = 'switched'
    `).run(new Date().toISOString(), '2026-01-01 12:00:00');

    await runTlsChecks(db, 6);
    const row = db.prepare(`SELECT tls_expires_at, tls_issuer, tls_subject_alt_names, tls_last_checked_at, tls_error
                            FROM http_endpoints WHERE name = 'switched'`).get();
    assert.equal(row.tls_expires_at, null);
    assert.equal(row.tls_issuer, null);
    assert.equal(row.tls_subject_alt_names, null);
    assert.equal(row.tls_last_checked_at, null);
    assert.equal(row.tls_error, null);
  });

  it('runTlsChecks honors the per-endpoint interval', async () => {
    seedHttpEndpoints(db, [{ name: 'recent', url: 'https://localhost:1' }]);
    // Stamp a very recent check so the endpoint isn't "due".
    db.prepare(`UPDATE http_endpoints SET tls_last_checked_at = datetime('now') WHERE name = 'recent'`).run();
    const before = db.prepare(`SELECT tls_last_checked_at FROM http_endpoints WHERE name = 'recent'`).get().tls_last_checked_at;

    await runTlsChecks(db, 24);
    const after = db.prepare(`SELECT tls_last_checked_at FROM http_endpoints WHERE name = 'recent'`).get().tls_last_checked_at;
    // Should not have re-probed (still the same timestamp).
    assert.equal(after, before);
  });
});
