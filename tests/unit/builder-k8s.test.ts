import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildK8sManifest } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/k8s');

describe('buildK8sManifest', () => {
  it('emits a kubectl apply heredoc containing DaemonSet + RBAC', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /kubectl apply -f -/);
    assert.match(out, /<<EOF/);
    assert.match(out, /\nEOF$/);
    assert.match(out, /kind: DaemonSet/);
    assert.match(out, /kind: ServiceAccount/);
    assert.match(out, /kind: ClusterRole/);
    assert.match(out, /kind: ClusterRoleBinding/);
  });

  it('substitutes the cluster name into INSIGHTD_HOST_GROUP env', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /name: INSIGHTD_HOST_GROUP\s*\n\s*value: homelab-k3s/);
  });

  it('substitutes broker URL', () => {
    const out = buildK8sManifest({
      identifier: 'homelab-k3s',
      broker: { url: 'mqtt://my-broker:1883' },
      permissions: { allowActions: true },
      advanced: {},
    });
    assert.match(out, /name: INSIGHTD_MQTT_URL\s*\n\s*value: mqtt:\/\/my-broker:1883/);
  });

  it('emits ALLOW_ACTIONS only when permissions.allowActions=true', () => {
    const on = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true }, advanced: {},
    });
    const off = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: false }, advanced: {},
    });
    assert.match(on,  /name: INSIGHTD_ALLOW_ACTIONS\s*\n\s*value: ['"]true['"]/);
    assert.doesNotMatch(off, /INSIGHTD_ALLOW_ACTIONS/);
  });

  it('uses provided image override', () => {
    const out = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true },
      advanced: { image: 'andreas404/insightd-agent:hub-v1.0.0' },
    });
    assert.match(out, /image: andreas404\/insightd-agent:hub-v1\.0\.0/);
  });

  it('emits collectInterval / tz / diskWarnThreshold only when set and != default', () => {
    const out = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true },
      advanced: { collectInterval: '15', tz: 'Europe/Oslo' },
    });
    assert.match(out, /name: INSIGHTD_COLLECT_INTERVAL\s*\n\s*value: ['"]15['"]/);
    assert.match(out, /name: TZ\s*\n\s*value: Europe\/Oslo/);
    assert.doesNotMatch(out, /INSIGHTD_DISK_WARN_THRESHOLD/);
  });

  it('includes pods/log, nodes/metrics, replicasets, and leader-election lease role', () => {
    const out = buildK8sManifest({
      identifier: 'c', broker: { url: 'mqtt://h:1883' },
      permissions: { allowActions: true }, advanced: {},
    });
    assert.match(out, /resources:.*pods\/log/);
    assert.match(out, /resources:.*nodes\/metrics/);
    assert.match(out, /resources:.*replicasets/);
    assert.match(out, /name: insightd-agent-lease/);
    assert.match(out, /apiGroups: \["coordination\.k8s\.io"\]/);
    assert.match(out, /resources:.*leases/);
  });
});
