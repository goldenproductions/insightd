import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb, seedHttpEndpoints } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');

const nodemailer = require('nodemailer');

describe('evaluateAlerts — TLS certificate alerts (hub)', () => {
  let db: any;
  let evaluateAlerts: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: mock.fn(async () => ({ messageId: 't' })) }));
    db = createTestDb();
    delete require.cache[require.resolve('../../hub/src/alerts/evaluator')];
    delete require.cache[require.resolve('../../hub/src/alerts/sender')];
    evaluateAlerts = require('../../hub/src/alerts/evaluator').evaluateAlerts;
  });

  afterEach(() => {
    db.close();
    restore();
    mock.restoreAll();
  });

  const baseCfg = {
    enabled: true, to: 't@t.com', cooldownMinutes: 60,
    containerDown: false, restartCount: 0,
    cpuPercent: 0, memoryMb: 0, diskPercent: 0,
    hostCpuPercent: 0, hostMemoryAvailableMb: 0, hostLoadThreshold: 0,
    hostOffline: false, hostOfflineMinutes: 0,
    containerUnhealthy: false, excludeContainers: '',
    endpointDown: false, endpointFailureThreshold: 3,
    containerMemoryLimitPercent: 0,
    containerCpuLimitPercent: 0,
    certExpiry: true,
    certExpiryWarnDays: 14,
  };

  function setTls(name: string, fields: { expiresAt?: string | null; error?: string | null; lastCheckedAt?: string | null }) {
    db.prepare(`
      UPDATE http_endpoints SET tls_expires_at = ?, tls_error = ?, tls_last_checked_at = ?, tls_issuer = 'Test CA'
      WHERE name = ?
    `).run(
      fields.expiresAt ?? null,
      fields.error ?? null,
      fields.lastCheckedAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
      name,
    );
  }

  function isoFromDays(days: number): string {
    return new Date(Date.now() + days * 86400000).toISOString();
  }

  it('fires cert_expiring_soon when cert expires within warn window', () => {
    seedHttpEndpoints(db, [{ name: 'soon', url: 'https://example.com' }]);
    setTls('soon', { expiresAt: isoFromDays(5) });

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    const alerts = triggered.filter((a: any) => a.type === 'cert_expiring_soon');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].target, 'soon');
    assert.match(alerts[0].message, /5 days?/);
  });

  it('fires cert_expired when cert is past expiry', () => {
    seedHttpEndpoints(db, [{ name: 'old', url: 'https://example.com' }]);
    setTls('old', { expiresAt: isoFromDays(-1) });

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    const alerts = triggered.filter((a: any) => a.type === 'cert_expired');
    assert.equal(alerts.length, 1);
    // Should NOT also fire expiring_soon — expired wins.
    assert.equal(triggered.filter((a: any) => a.type === 'cert_expiring_soon').length, 0);
  });

  it('fires cert_invalid for self-signed without expiring_soon', () => {
    seedHttpEndpoints(db, [{ name: 'badchain', url: 'https://internal.lan' }]);
    setTls('badchain', { expiresAt: isoFromDays(60), error: 'self-signed' });

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    const invalid = triggered.filter((a: any) => a.type === 'cert_invalid');
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].message, /self-signed/);
    assert.equal(triggered.filter((a: any) => a.type === 'cert_expiring_soon').length, 0);
  });

  it('does not fire when cert is comfortably valid', () => {
    seedHttpEndpoints(db, [{ name: 'good', url: 'https://example.com' }]);
    setTls('good', { expiresAt: isoFromDays(60) });

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    assert.equal(triggered.filter((a: any) => a.type.startsWith('cert_')).length, 0);
  });

  it('does not fire on transient timeout errors (no cert data poisoning)', () => {
    seedHttpEndpoints(db, [{ name: 'flaky', url: 'https://example.com' }]);
    setTls('flaky', { expiresAt: isoFromDays(60), error: 'timeout' });

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    assert.equal(triggered.filter((a: any) => a.type === 'cert_invalid').length, 0);
  });

  it('skips http endpoints entirely', () => {
    seedHttpEndpoints(db, [{ name: 'plain', url: 'http://example.com' }]);
    setTls('plain', { expiresAt: isoFromDays(-1) }); // even with bad data, http skips

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    assert.equal(triggered.filter((a: any) => a.type.startsWith('cert_')).length, 0);
  });

  it('skips endpoints that have not been probed yet', () => {
    seedHttpEndpoints(db, [{ name: 'fresh', url: 'https://example.com' }]);
    // No setTls — tls_last_checked_at is NULL.

    const { triggered } = evaluateAlerts(db, { alerts: baseCfg });
    assert.equal(triggered.filter((a: any) => a.type.startsWith('cert_')).length, 0);
  });

  it('respects certExpiry kill switch', () => {
    seedHttpEndpoints(db, [{ name: 'soon2', url: 'https://example.com' }]);
    setTls('soon2', { expiresAt: isoFromDays(5) });

    const { triggered } = evaluateAlerts(db, { alerts: { ...baseCfg, certExpiry: false } });
    assert.equal(triggered.filter((a: any) => a.type.startsWith('cert_')).length, 0);
  });
});
