import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { getSettings, putSettings, getEffectiveConfig } = require('../../hub/src/db/settings');

describe('settings', () => {
  let db: any;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  describe('getSettings', () => {
    it('returns all settings with defaults', () => {
      const settings = getSettings(db);
      assert.ok(settings.length > 0);
      const smtp = settings.find((s: any) => s.key === 'smtp.host');
      assert.equal(smtp.category, 'Email');
    });

    it('returns db source when setting is stored', () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alerts.cpuPercent', '80')").run();
      const settings = getSettings(db);
      const cpu = settings.find((s: any) => s.key === 'alerts.cpuPercent');
      assert.equal(cpu.value, '80');
      assert.equal(cpu.source, 'db');
    });

    it('masks sensitive values', () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('smtp.pass', 'secret123')").run();
      const settings = getSettings(db);
      const pass = settings.find((s: any) => s.key === 'smtp.pass');
      assert.equal(pass.value, '****');
      assert.equal(pass.sensitive, true);
    });
  });

  describe('putSettings', () => {
    it('saves valid settings to db', () => {
      putSettings(db, { 'alerts.cpuPercent': '80' });
      const row = db.prepare("SELECT value FROM settings WHERE key = 'alerts.cpuPercent'").get();
      assert.equal(row.value, '80');
    });

    it('ignores unknown keys', () => {
      putSettings(db, { 'unknown.key': 'value' });
      const row = db.prepare("SELECT value FROM settings WHERE key = 'unknown.key'").get();
      assert.equal(row, undefined);
    });

    it('skips masked sensitive values', () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('smtp.pass', 'real-password')").run();
      putSettings(db, { 'smtp.pass': '****' });
      const row = db.prepare("SELECT value FROM settings WHERE key = 'smtp.pass'").get();
      assert.equal(row.value, 'real-password');
    });

    it('returns restartRequired for non-hot-reload settings', () => {
      const result = putSettings(db, { 'collectIntervalMinutes': '10' });
      assert.equal(result.restartRequired, true);
    });

    it('returns restartRequired false for hot-reload settings', () => {
      const result = putSettings(db, { 'alerts.cpuPercent': '80' });
      assert.equal(result.restartRequired, false);
    });
  });

  describe('getEffectiveConfig', () => {
    const base = {
      digestTo: 'test@test.com', diskWarnPercent: 85,
      smtp: { host: 'smtp.test.com', port: 587, user: '', pass: '', from: '' },
      alerts: {
        enabled: false, to: '', cooldownMinutes: 60, cpuPercent: 90, memoryMb: 0,
        diskPercent: 90, restartCount: 3, containerDown: true, hostCpuPercent: 90,
        hostMemoryAvailableMb: 0, hostLoadThreshold: 0, containerUnhealthy: true,
      },
    };

    it('returns base config when no db overrides', () => {
      const effective = getEffectiveConfig(db, base);
      assert.equal(effective.alerts.cpuPercent, 90);
    });

    it('overrides with db values', () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alerts.cpuPercent', '75')").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('alerts.enabled', 'true')").run();
      const effective = getEffectiveConfig(db, base);
      assert.equal(effective.alerts.cpuPercent, 75);
      assert.equal(effective.alerts.enabled, true);
    });
  });
});
