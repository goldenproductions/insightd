const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedHttpEndpoints, seedHttpChecks } = require('../helpers/db');
const { ts, NOW, THIS_WEEK } = require('../helpers/fixtures');
const { suppressConsole } = require('../helpers/mocks');
const queries = require('../../hub/src/http-monitor/queries');

describe('http-monitor queries', () => {
  let db, restore;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    restore();
  });

  describe('createEndpoint', () => {
    it('should create an endpoint with defaults', () => {
      const { id } = queries.createEndpoint(db, { name: 'My API', url: 'https://api.example.com/health' });
      assert.ok(id > 0);
      const ep = queries.getEndpoint(db, id);
      assert.equal(ep.name, 'My API');
      assert.equal(ep.url, 'https://api.example.com/health');
      assert.equal(ep.method, 'GET');
      assert.equal(ep.expected_status, 200);
      assert.equal(ep.interval_seconds, 60);
      assert.equal(ep.timeout_ms, 10000);
      assert.equal(ep.enabled, 1);
    });

    it('should create an endpoint with custom values', () => {
      const { id } = queries.createEndpoint(db, {
        name: 'HEAD check', url: 'https://example.com',
        method: 'HEAD', expectedStatus: 204, intervalSeconds: 30, timeoutMs: 5000, enabled: false,
      });
      const ep = queries.getEndpoint(db, id);
      assert.equal(ep.method, 'HEAD');
      assert.equal(ep.expected_status, 204);
      assert.equal(ep.interval_seconds, 30);
      assert.equal(ep.timeout_ms, 5000);
      assert.equal(ep.enabled, 0);
    });
  });

  describe('updateEndpoint', () => {
    it('should update specific fields', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      queries.updateEndpoint(db, id, { name: 'Updated', intervalSeconds: 120 });
      const ep = queries.getEndpoint(db, id);
      assert.equal(ep.name, 'Updated');
      assert.equal(ep.interval_seconds, 120);
      assert.equal(ep.url, 'https://test.com'); // unchanged
    });

    it('should return updated false when no fields', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      const result = queries.updateEndpoint(db, id, {});
      assert.equal(result.updated, false);
    });
  });

  describe('deleteEndpoint', () => {
    it('should delete endpoint and cascade checks', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      queries.insertCheck(db, id, { statusCode: 200, responseTimeMs: 50, isUp: true });
      queries.deleteEndpoint(db, id);
      assert.equal(queries.getEndpoint(db, id), null);
      assert.equal(queries.getChecks(db, id, 24).length, 0);
    });

    it('should return deleted false for non-existent', () => {
      const result = queries.deleteEndpoint(db, 999);
      assert.equal(result.deleted, false);
    });
  });

  describe('getEndpoints', () => {
    it('should return endpoints sorted by name', () => {
      queries.createEndpoint(db, { name: 'Zebra', url: 'https://z.com' });
      queries.createEndpoint(db, { name: 'Alpha', url: 'https://a.com' });
      const endpoints = queries.getEndpoints(db);
      assert.equal(endpoints.length, 2);
      assert.equal(endpoints[0].name, 'Alpha');
      assert.equal(endpoints[1].name, 'Zebra');
    });
  });

  describe('insertCheck and getChecks', () => {
    it('should insert and retrieve checks', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      queries.insertCheck(db, id, { statusCode: 200, responseTimeMs: 42, isUp: true });
      queries.insertCheck(db, id, { statusCode: null, responseTimeMs: null, isUp: false, error: 'ECONNREFUSED' });
      const checks = queries.getChecks(db, id, 24);
      assert.equal(checks.length, 2);
      assert.equal(checks[0].is_up, 0); // newest first
      assert.equal(checks[0].error, 'ECONNREFUSED');
      assert.equal(checks[1].is_up, 1);
      assert.equal(checks[1].response_time_ms, 42);
    });
  });

  describe('getEndpointSummary', () => {
    it('should calculate uptime and avg response', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      // Seed checks: 9 up, 1 down
      for (let i = 0; i < 9; i++) {
        seedHttpChecks(db, [{ endpointId: id, statusCode: 200, responseTimeMs: 100, isUp: true, at: ts(NOW) }]);
      }
      seedHttpChecks(db, [{ endpointId: id, statusCode: null, responseTimeMs: null, isUp: false, error: 'timeout', at: ts(NOW) }]);

      const summary = queries.getEndpointSummary(db, id);
      assert.equal(summary.uptimePercent24h, 90);
      assert.equal(summary.avgResponseMs, 100);
      assert.ok(summary.lastCheck);
    });

    it('should return null for no checks', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      const summary = queries.getEndpointSummary(db, id);
      assert.equal(summary.uptimePercent24h, null);
      assert.equal(summary.avgResponseMs, null);
      assert.equal(summary.lastCheck, null);
    });
  });

  describe('getEndpointsSummary', () => {
    it('should return all endpoints with stats', () => {
      const { id: id1 } = queries.createEndpoint(db, { name: 'API 1', url: 'https://api1.com' });
      const { id: id2 } = queries.createEndpoint(db, { name: 'API 2', url: 'https://api2.com' });
      seedHttpChecks(db, [{ endpointId: id1, statusCode: 200, responseTimeMs: 50, isUp: true, at: ts(NOW) }]);
      seedHttpChecks(db, [{ endpointId: id2, statusCode: 500, responseTimeMs: 200, isUp: false, at: ts(NOW) }]);

      const summaries = queries.getEndpointsSummary(db);
      assert.equal(summaries.length, 2);
      assert.equal(summaries[0].name, 'API 1');
      assert.ok(summaries[0].lastCheck);
    });
  });

  describe('getEndpointsForDigest', () => {
    it('should return 7-day stats', () => {
      const { id } = queries.createEndpoint(db, { name: 'Digest EP', url: 'https://digest.com' });
      seedHttpChecks(db, [
        { endpointId: id, statusCode: 200, responseTimeMs: 100, isUp: true, at: ts(THIS_WEEK) },
        { endpointId: id, statusCode: 200, responseTimeMs: 200, isUp: true, at: ts(NOW) },
      ]);

      const digest = queries.getEndpointsForDigest(db);
      assert.equal(digest.length, 1);
      assert.equal(digest[0].name, 'Digest EP');
      assert.equal(digest[0].uptimePercent, 100);
      assert.equal(digest[0].avgResponseMs, 150);
      assert.equal(digest[0].totalChecks, 2);
    });
  });

  describe('getLastNChecks', () => {
    it('should return last N checks newest first', () => {
      const { id } = queries.createEndpoint(db, { name: 'Test', url: 'https://test.com' });
      seedHttpChecks(db, [
        { endpointId: id, statusCode: 200, isUp: true, at: '2026-03-31 10:00:00' },
        { endpointId: id, statusCode: 500, isUp: false, at: '2026-03-31 10:01:00' },
        { endpointId: id, statusCode: null, isUp: false, at: '2026-03-31 10:02:00' },
      ]);
      const checks = queries.getLastNChecks(db, id, 2);
      assert.equal(checks.length, 2);
      assert.equal(checks[0].is_up, 0); // newest
      assert.equal(checks[1].is_up, 0);
    });
  });
});
