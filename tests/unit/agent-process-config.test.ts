import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'INSIGHTD_PROCESS_ENABLED', 'INSIGHTD_PROCESS_INTERVAL_MS',
  'INSIGHTD_PROCESS_ARGV_MAX', 'INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS',
];

const savedEnv: Record<string, string | undefined> = {};

function loadConfig() {
  delete require.cache[require.resolve('../../agent/src/config')];
  return require('../../agent/src/config');
}

describe('agent process config', () => {
  before(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it('uses defaults when env absent', () => {
    const { config } = loadConfig();
    assert.equal(config.processCollection.enabled, true);
    assert.equal(config.processCollection.pollIntervalMs, 5000);
    assert.equal(config.processCollection.argvMaxBytes, 4096);
    assert.equal(config.processCollection.dockerTopTimeoutMs, 2000);
  });

  it('honors env overrides', () => {
    process.env.INSIGHTD_PROCESS_ENABLED = 'false';
    process.env.INSIGHTD_PROCESS_INTERVAL_MS = '10000';
    process.env.INSIGHTD_PROCESS_ARGV_MAX = '2048';
    process.env.INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS = '500';
    const { config } = loadConfig();
    assert.equal(config.processCollection.enabled, false);
    assert.equal(config.processCollection.pollIntervalMs, 10000);
    assert.equal(config.processCollection.argvMaxBytes, 2048);
    assert.equal(config.processCollection.dockerTopTimeoutMs, 500);
  });
});
