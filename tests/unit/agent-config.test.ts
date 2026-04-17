import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_PATH = require.resolve('../../agent/src/config');

// Snapshot env vars we mutate so tests can roll them back.
const ENV_KEYS = [
  'INSIGHTD_MQTT_URL',
  'INSIGHTD_HOST_ID',
  'INSIGHTD_RUNTIME',
  'INSIGHTD_ALLOW_UPDATES',
  'INSIGHTD_ALLOW_ACTIONS',
  'INSIGHTD_KUBELET_URL',
  'KUBERNETES_SERVICE_HOST',
  'NODE_NAME',
];

function loadFresh(): { config: any; validate: () => string[] } {
  delete require.cache[CONFIG_PATH];
  return require('../../agent/src/config');
}

describe('agent config validate()', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Baseline: valid minimal config that passes the required-var checks.
    process.env.INSIGHTD_MQTT_URL = 'mqtt://broker.test:1883';
    process.env.INSIGHTD_HOST_ID = 'test-host';
    delete process.env.INSIGHTD_RUNTIME;
    delete process.env.INSIGHTD_ALLOW_UPDATES;
    delete process.env.INSIGHTD_ALLOW_ACTIONS;
    delete process.env.INSIGHTD_KUBELET_URL;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[CONFIG_PATH];
  });

  it('returns no warnings for a valid Docker-mode config', () => {
    const { validate } = loadFresh();
    assert.deepEqual(validate(), []);
  });

  it('warns when allowUpdates=true in explicit kubernetes mode', () => {
    process.env.INSIGHTD_RUNTIME = 'kubernetes';
    process.env.INSIGHTD_ALLOW_UPDATES = 'true';
    const { validate } = loadFresh();
    const warnings = validate();
    assert.ok(
      warnings.some(w => w.includes('INSIGHTD_ALLOW_UPDATES') && w.includes('Kubernetes')),
      `expected k8s update warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('warns when allowActions=true in explicit kubernetes mode', () => {
    process.env.INSIGHTD_RUNTIME = 'kubernetes';
    process.env.INSIGHTD_ALLOW_ACTIONS = 'true';
    const { validate } = loadFresh();
    const warnings = validate();
    assert.ok(
      warnings.some(w => w.includes('INSIGHTD_ALLOW_ACTIONS') && w.includes('Kubernetes')),
      `expected k8s actions warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('warns when runtime=auto and KUBERNETES_SERVICE_HOST is set (in-cluster auto-detect)', () => {
    process.env.INSIGHTD_RUNTIME = 'auto';
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
    process.env.INSIGHTD_ALLOW_ACTIONS = 'true';
    const { validate } = loadFresh();
    const warnings = validate();
    assert.ok(
      warnings.some(w => w.includes('INSIGHTD_ALLOW_ACTIONS')),
      `expected k8s actions warning for auto-detect, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('does not warn about allowActions in Docker mode', () => {
    process.env.INSIGHTD_RUNTIME = 'docker';
    process.env.INSIGHTD_ALLOW_ACTIONS = 'true';
    const { validate } = loadFresh();
    const warnings = validate();
    assert.equal(
      warnings.filter(w => w.includes('Kubernetes')).length,
      0,
      `no k8s warnings expected in docker mode, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('exposes INSIGHTD_KUBELET_URL on the config object', () => {
    process.env.INSIGHTD_KUBELET_URL = 'https://override.local:10250';
    const { config } = loadFresh();
    assert.equal(config.kubeletUrl, 'https://override.local:10250');
  });

  it('defaults kubeletUrl to empty string when unset', () => {
    const { config } = loadFresh();
    assert.equal(config.kubeletUrl, '');
  });
});
