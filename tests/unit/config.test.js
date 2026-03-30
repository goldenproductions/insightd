const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('config', () => {
  const savedEnv = {};
  const envKeys = [
    'INSIGHTD_DATA_DIR', 'INSIGHTD_COLLECT_INTERVAL', 'DOCKER_HOST',
    'INSIGHTD_HOST_ROOT', 'INSIGHTD_DIGEST_CRON', 'TZ',
    'INSIGHTD_SMTP_HOST', 'INSIGHTD_SMTP_PORT', 'INSIGHTD_SMTP_USER',
    'INSIGHTD_SMTP_PASS', 'INSIGHTD_SMTP_FROM', 'INSIGHTD_DIGEST_TO',
    'INSIGHTD_DISK_WARN_THRESHOLD', 'INSIGHTD_UPDATE_CHECK_CRON',
  ];

  function loadConfig() {
    delete require.cache[require.resolve('../../src/config')];
    return require('../../src/config');
  }

  before(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  describe('defaults', () => {
    it('uses default values when no env vars set', () => {
      const { config } = loadConfig();
      assert.equal(config.dataDir, '/data');
      assert.equal(config.collectIntervalMinutes, 5);
      assert.equal(config.dockerSocket, '/var/run/docker.sock');
      assert.equal(config.hostRoot, '/host');
      assert.equal(config.digestCron, '0 8 * * 1');
      assert.equal(config.timezone, 'UTC');
      assert.equal(config.smtp.port, 587);
      assert.equal(config.diskWarnPercent, 85);
    });
  });

  describe('custom values', () => {
    it('reads from environment variables', () => {
      process.env.INSIGHTD_DATA_DIR = '/custom/data';
      process.env.INSIGHTD_COLLECT_INTERVAL = '10';
      process.env.INSIGHTD_SMTP_HOST = 'smtp.test.com';
      process.env.INSIGHTD_SMTP_PORT = '465';
      process.env.INSIGHTD_DISK_WARN_THRESHOLD = '90';
      process.env.TZ = 'Europe/Oslo';

      const { config } = loadConfig();
      assert.equal(config.dataDir, '/custom/data');
      assert.equal(config.collectIntervalMinutes, 10);
      assert.equal(config.smtp.host, 'smtp.test.com');
      assert.equal(config.smtp.port, 465);
      assert.equal(config.diskWarnPercent, 90);
      assert.equal(config.timezone, 'Europe/Oslo');

      // Cleanup
      for (const key of envKeys) delete process.env[key];
    });
  });

  describe('validate()', () => {
    it('returns warnings when SMTP host is empty', () => {
      const { validate } = loadConfig();
      const warnings = validate();
      assert.ok(warnings.some(w => w.includes('SMTP_HOST')));
    });

    it('returns warnings when digestTo is empty', () => {
      const { validate } = loadConfig();
      const warnings = validate();
      assert.ok(warnings.some(w => w.includes('DIGEST_TO')));
    });

    it('returns no warnings when configured', () => {
      process.env.INSIGHTD_SMTP_HOST = 'smtp.test.com';
      process.env.INSIGHTD_DIGEST_TO = 'test@test.com';
      const { validate } = loadConfig();
      const warnings = validate();
      assert.equal(warnings.length, 0);

      delete process.env.INSIGHTD_SMTP_HOST;
      delete process.env.INSIGHTD_DIGEST_TO;
    });
  });

  describe('frozen config', () => {
    it('config object is frozen', () => {
      const { config } = loadConfig();
      assert.ok(Object.isFrozen(config));
    });

    it('smtp sub-object is frozen', () => {
      const { config } = loadConfig();
      assert.ok(Object.isFrozen(config.smtp));
    });
  });
});
