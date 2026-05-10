import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildPveInstallCommand } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/pve');

describe('buildPveInstallCommand', () => {
  it('emits a curl-pipe-bash one-liner with required env vars', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: {},
    });
    assert.match(out, /curl -fsSL https:\/\/get\.insightd\.org\/install/);
    assert.match(out, /INSIGHTD_HOST_ID=proxmox-01/);
    assert.match(out, /INSIGHTD_MQTT_URL=mqtt:\/\/hub:1883/);
    assert.match(out, /INSIGHTD_ALLOW_UPDATES=true/);
    assert.match(out, /\| bash$/);
  });

  it('omits MQTT_USER and MQTT_PASS when not provided', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: {},
    });
    assert.doesNotMatch(out, /INSIGHTD_MQTT_USER/);
    assert.doesNotMatch(out, /INSIGHTD_MQTT_PASS/);
  });

  it('omits advanced field when value equals default', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: { updateCheckCron: '0 3 * * *' },
    });
    assert.doesNotMatch(out, /INSIGHTD_UPDATE_CHECK_CRON/);
  });

  it('quotes advanced values that contain whitespace', () => {
    const out = buildPveInstallCommand({
      identifier: 'proxmox-01',
      broker: { url: 'mqtt://hub:1883' },
      permissions: { allowUpdates: true, allowActions: true },
      advanced: { updateCheckCron: '*/15 * * * *' },
    });
    assert.match(out, /INSIGHTD_UPDATE_CHECK_CRON="\*\/15 \* \* \* \*"/);
  });
});
