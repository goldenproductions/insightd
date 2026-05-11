import { test } from 'node:test';
import assert from 'node:assert/strict';
const { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS, effectiveSeverity } = require('../hub/src/alerts/severity');

test('every critical default matches the design spec', () => {
  const critical = [
    'host_offline', 'container_down', 'workload_unavailable', 'endpoint_down',
    'pve_cluster_quorum_lost', 'node_not_ready', 'pve_zfs_unhealthy',
    'cert_expired', 'disk_full', 'pve_storage_saturation', 'image_pull_failure',
  ];
  for (const t of critical) {
    assert.equal(DEFAULT_SEVERITY[t], 'critical', `${t} should default to critical`);
  }
});

test('every warning default is present', () => {
  const warnings = [
    'restart_loop', 'high_cpu', 'high_memory', 'container_memory_saturation',
    'container_cpu_saturation', 'high_host_cpu', 'low_host_memory', 'high_load',
    'container_unhealthy', 'node_pressure', 'workload_degraded',
    'workload_rollout_stuck', 'pod_pending', 'cert_expiring_soon',
    'cert_invalid', 'pve_backup_overdue',
  ];
  for (const t of warnings) {
    assert.equal(DEFAULT_SEVERITY[t], 'warning', `${t} should default to warning`);
  }
});

test('every alert type has a description', () => {
  for (const t of Object.keys(DEFAULT_SEVERITY)) {
    assert.ok(ALERT_DESCRIPTIONS[t], `${t} missing description`);
    assert.ok(ALERT_DESCRIPTIONS[t].length > 10, `${t} description too short`);
  }
});

test('effectiveSeverity downgrades disk_full below diskCriticalPercent', () => {
  const rule = { alert_type: 'disk_full', severity: 'critical', enabled: 1, mail: 1, webhook: 1 };
  assert.equal(effectiveSeverity({ type: 'disk_full', value: 90 }, rule, 95), 'warning');
  assert.equal(effectiveSeverity({ type: 'disk_full', value: 96 }, rule, 95), 'critical');
});

test('effectiveSeverity passes through non-disk types', () => {
  const rule = { alert_type: 'host_offline', severity: 'critical', enabled: 1, mail: 1, webhook: 1 };
  assert.equal(effectiveSeverity({ type: 'host_offline', value: 30 }, rule, 95), 'critical');
});
