import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHttpEndpoints, seedHttpChecks } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const { ts, NOW } = require('../helpers/fixtures');

describe('HTTP checker', () => {
  let db: any, restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  describe('probeEndpoint', () => {
    it('should return isUp true for matching status', async () => {
      // Mock global fetch
      mock.method(global, 'fetch', async () => ({
        status: 200,
      }));

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      const result = await probeEndpoint({
        url: 'https://example.com', method: 'GET', expected_status: 200, timeout_ms: 5000,
      });
      assert.equal(result.isUp, true);
      assert.equal(result.statusCode, 200);
      assert.equal(typeof result.responseTimeMs, 'number');
      assert.equal(result.error, null);
    });

    it('should return isUp false for mismatched status', async () => {
      mock.method(global, 'fetch', async () => ({
        status: 503,
      }));

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      const result = await probeEndpoint({
        url: 'https://example.com', method: 'GET', expected_status: 200, timeout_ms: 5000,
      });
      assert.equal(result.isUp, false);
      assert.equal(result.statusCode, 503);
      assert.equal(result.error, 'Expected 200, got 503');
    });

    it('should handle connection errors', async () => {
      mock.method(global, 'fetch', async () => {
        throw new Error('ECONNREFUSED');
      });

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      const result = await probeEndpoint({
        url: 'https://down.example.com', method: 'GET', expected_status: 200, timeout_ms: 5000,
      });
      assert.equal(result.isUp, false);
      assert.equal(result.statusCode, null);
      assert.equal(result.responseTimeMs, null);
      assert.ok(result.error.includes('ECONNREFUSED'));
    });

    it('should handle abort/timeout', async () => {
      mock.method(global, 'fetch', async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      const result = await probeEndpoint({
        url: 'https://slow.example.com', method: 'GET', expected_status: 200, timeout_ms: 1000,
      });
      assert.equal(result.isUp, false);
      assert.ok(result.error.includes('Timeout'));
    });

    it('should pass custom headers', async () => {
      let receivedHeaders: any;
      mock.method(global, 'fetch', async (url: string, opts: any) => {
        receivedHeaders = opts.headers;
        return { status: 200 };
      });

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      await probeEndpoint({
        url: 'https://example.com', method: 'GET', expected_status: 200, timeout_ms: 5000,
        headers: '{"Authorization":"Bearer test123"}',
      });
      assert.equal(receivedHeaders.Authorization, 'Bearer test123');
    });

    it('should use HEAD method when specified', async () => {
      let receivedMethod: string;
      mock.method(global, 'fetch', async (url: string, opts: any) => {
        receivedMethod = opts.method;
        return { status: 200 };
      });

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { probeEndpoint } = require('../../hub/src/http-monitor/checker');

      await probeEndpoint({
        url: 'https://example.com', method: 'HEAD', expected_status: 200, timeout_ms: 5000,
      });
      assert.equal(receivedMethod!, 'HEAD');
    });
  });

  describe('runChecks', () => {
    it('should check due endpoints and insert results', async () => {
      mock.method(global, 'fetch', async () => ({ status: 200 }));

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { runChecks } = require('../../hub/src/http-monitor/checker');

      seedHttpEndpoints(db, [{ name: 'Test', url: 'https://test.com', intervalSeconds: 60 }]);
      await runChecks(db);

      const checks = db.prepare('SELECT * FROM http_checks').all();
      assert.equal(checks.length, 1);
      assert.equal(checks[0].is_up, 1);
      assert.equal(checks[0].status_code, 200);
    });

    it('should skip endpoints not yet due', async () => {
      mock.method(global, 'fetch', async () => ({ status: 200 }));

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { runChecks } = require('../../hub/src/http-monitor/checker');

      const [id] = seedHttpEndpoints(db, [{ name: 'Test', url: 'https://test.com', intervalSeconds: 300 }]);
      // Seed a recent check
      seedHttpChecks(db, [{ endpointId: id, statusCode: 200, isUp: true, at: ts(NOW) }]);

      await runChecks(db);

      // Should still be just the 1 seeded check
      const checks = db.prepare('SELECT * FROM http_checks').all();
      assert.equal(checks.length, 1);
    });

    it('should skip disabled endpoints', async () => {
      mock.method(global, 'fetch', async () => ({ status: 200 }));

      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { runChecks } = require('../../hub/src/http-monitor/checker');

      seedHttpEndpoints(db, [{ name: 'Disabled', url: 'https://test.com', enabled: false }]);
      await runChecks(db);

      const checks = db.prepare('SELECT * FROM http_checks').all();
      assert.equal(checks.length, 0);
    });

    it('should handle no endpoints gracefully', async () => {
      delete require.cache[require.resolve('../../hub/src/http-monitor/checker')];
      const { runChecks } = require('../../hub/src/http-monitor/checker');
      await runChecks(db); // Should not throw
    });
  });
});
