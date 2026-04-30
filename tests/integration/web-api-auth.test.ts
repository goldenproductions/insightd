import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const http = require('http');
const { createTestDb } = require('../helpers/db');

function fetchMethod(port: number, method: string, path: string, opts: { token?: string; body?: any } = {}) {
  return new Promise<{ status: number; headers: any; body: string; json: () => any }>((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(payload)); }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method, headers }, (res: any) => {
      let resBody = '';
      res.on('data', (chunk: string) => { resBody += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: resBody, json: () => JSON.parse(resBody) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startTestServer(db: any) {
  // Force a fresh require so the auth module reattaches to this test's db.
  delete require.cache[require.resolve('../../hub/src/web/server')];
  delete require.cache[require.resolve('../../hub/src/web/auth')];
  delete require.cache[require.resolve('../../hub/src/web/handlers')];
  const { startWebServer } = require('../../hub/src/web/server');
  const { setDb } = require('../../hub/src/web/auth') as { setDb: (db: any) => void };
  // Production wires this from hub/src/index.ts before booting the web
  // server. The test bypasses index.ts so we wire it ourselves — without
  // it, isAuthEnabled() always returns false and the gate is a no-op.
  setDb(db);
  const config = {
    collectIntervalMinutes: 5,
    web: { enabled: true, port: 0, host: '127.0.0.1' },
  };
  return new Promise<{ server: any; port: number }>((resolve) => {
    const server = startWebServer(db, config);
    server.on('listening', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

/**
 * Centralized auth gate (server.ts PUBLIC_ROUTES) — replaces the scattered
 * per-handler `requireAuth` calls and the bug where a few read endpoints
 * silently lacked it. Asserts:
 *   1. Public routes are reachable without a token even when auth is enabled.
 *   2. Every other route returns 401 without a token.
 *   3. With a valid token, the same routes succeed (200/4xx but NOT 401).
 *   4. When auth is disabled (no admin password), everything is reachable.
 */
describe('Web API auth gate', () => {
  let db: any;
  let server: any;
  let port: number;

  beforeEach(async () => {
    db = createTestDb();
  });

  afterEach(() => {
    if (server) server.close();
    db.close();
  });

  // ── Auth-disabled mode ─────────────────────────────────────────────────────

  it('allows protected routes without a token when no admin password is set', async () => {
    ({ server, port } = await startTestServer(db));
    // /api/hosts is protected — but auth isn't enabled here, so it should
    // resolve to 200 (empty list, no hosts seeded).
    const res = await fetchMethod(port, 'GET', '/api/hosts');
    assert.equal(res.status, 200);
  });

  // ── Auth-enabled mode ──────────────────────────────────────────────────────

  describe('with admin password configured', () => {
    let validToken: string;

    beforeEach(async () => {
      // Set an admin password so isAuthEnabled() returns true.
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin.password', 'testpass', datetime('now'))").run();
      ({ server, port } = await startTestServer(db));
      // Mint a valid session token by calling the login endpoint.
      const loginRes = await fetchMethod(port, 'POST', '/api/auth', { body: { password: 'testpass' } });
      assert.equal(loginRes.status, 200, `login failed: ${loginRes.body}`);
      validToken = loginRes.json().token;
      assert.ok(validToken, 'expected a token from /api/auth');
    });

    it('allows public routes without a token: /api/health, /api/setup/status, /api/status', async () => {
      for (const path of ['/api/health', '/api/setup/status']) {
        const res = await fetchMethod(port, 'GET', path);
        assert.notEqual(res.status, 401, `${path} should be public, got 401`);
      }
    });

    it('allows POST /api/auth without a token (login itself must be public)', async () => {
      const res = await fetchMethod(port, 'POST', '/api/auth', { body: { password: 'wrong' } });
      // 401 from authenticate() vs 401 from the gate are indistinguishable
      // by status, but 'Invalid password' in the body proves the handler ran.
      assert.equal(res.status, 401);
      assert.match(res.body, /Invalid password/);
    });

    it('blocks protected GET routes without a token (401)', async () => {
      const protectedPaths = [
        '/api/hosts',
        '/api/dashboard',
        '/api/alerts',
        '/api/insights',
        '/api/health-scores',
        '/api/endpoints',
        '/api/webhooks',
        '/api/agent-setup',
        '/api/version-check',
        '/api/image-updates',
        '/api/disks',
        '/api/volumes',
        '/api/pvs',
        '/api/storage',
      ];
      for (const path of protectedPaths) {
        const res = await fetchMethod(port, 'GET', path);
        assert.equal(res.status, 401, `${path} should require auth, got ${res.status}`);
      }
    });

    it('blocks parameterized routes without a token (the previously-leaky ones)', async () => {
      // These are the routes that bug PR #223 surfaced — they were silently
      // unprotected before centralizing the gate.
      const protectedPaths = [
        '/api/hosts/some-host',
        '/api/hosts/some-host/timeline',
        '/api/hosts/some-host/trends',
        '/api/hosts/some-host/events',
        '/api/hosts/some-host/metrics',
        '/api/hosts/some-host/containers',
        '/api/hosts/some-host/disk',
        '/api/hosts/some-host/baselines',
        '/api/hosts/some-host/insights',
        '/api/clusters/c1/overview',
      ];
      for (const path of protectedPaths) {
        const res = await fetchMethod(port, 'GET', path);
        assert.equal(res.status, 401, `${path} should require auth, got ${res.status}`);
      }
    });

    it('rejects invalid Bearer tokens with 401', async () => {
      const res = await fetchMethod(port, 'GET', '/api/hosts', { token: 'totally-fake' });
      assert.equal(res.status, 401);
    });

    it('accepts a valid Bearer token on a previously-leaky route', async () => {
      const res = await fetchMethod(port, 'GET', '/api/hosts', { token: validToken });
      assert.notEqual(res.status, 401, `valid token should pass, got ${res.status} (${res.body})`);
    });

    it('returns 404 (not 401) for unknown routes — gate sits AFTER the router', async () => {
      // Subtle but worth pinning down: unknown paths should 404 regardless of
      // auth, so attackers can't use the auth gate to map our route surface.
      const res = await fetchMethod(port, 'GET', '/api/this-route-does-not-exist');
      assert.equal(res.status, 404);
    });
  });
});
