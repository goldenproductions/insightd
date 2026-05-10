import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { buildDockerCommand } = require('../../hub/src/web/frontend/src/pages/add-agent/builders/docker');

interface Inputs { identifier: string; broker: { url: string; user?: string; pass?: string };
                   permissions: { allowUpdates: boolean; allowActions: boolean };
                   advanced: Record<string, string | undefined>;
                   image: string; }

function defaults(over: Partial<Inputs> = {}): Inputs {
  return {
    identifier: 'nas-01',
    broker: { url: 'mqtt://hub:1883' },
    permissions: { allowUpdates: true, allowActions: true },
    advanced: {},
    image: 'andreas404/insightd-agent:latest',
    ...over,
  };
}

describe('buildDockerCommand', () => {
  it('emits a default docker run with required env vars', () => {
    const out = buildDockerCommand(defaults());
    assert.match(out, /docker run -d/);
    assert.match(out, /--name insightd-agent/);
    assert.match(out, /-e INSIGHTD_HOST_ID=nas-01/);
    assert.match(out, /-e INSIGHTD_MQTT_URL=mqtt:\/\/hub:1883/);
    assert.match(out, /-e INSIGHTD_ALLOW_UPDATES=true/);
    assert.match(out, /-e INSIGHTD_ALLOW_ACTIONS=true/);
    assert.match(out, /andreas404\/insightd-agent:latest/);
  });

  it('mounts the docker socket read-only when allow_updates=false', () => {
    const out = buildDockerCommand(defaults({ permissions: { allowUpdates: false, allowActions: true } }));
    assert.match(out, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
    assert.doesNotMatch(out, /-e INSIGHTD_ALLOW_UPDATES=true/);
  });

  it('omits ALLOW_ACTIONS when false (only non-default values are emitted)', () => {
    const out = buildDockerCommand(defaults({ permissions: { allowUpdates: true, allowActions: false } }));
    assert.doesNotMatch(out, /-e INSIGHTD_ALLOW_ACTIONS=true/);
  });

  it('emits MQTT user/pass only when set', () => {
    const out = buildDockerCommand(defaults({ broker: { url: 'mqtt://hub:1883', user: 'agent', pass: 'sec' } }));
    assert.match(out, /-e INSIGHTD_MQTT_USER=agent/);
    assert.match(out, /-e INSIGHTD_MQTT_PASS=sec/);
  });

  it('emits advanced env only when set and != default', () => {
    const out = buildDockerCommand(defaults({ advanced: { collectInterval: '10', tz: 'Europe/Oslo' } }));
    assert.match(out, /-e INSIGHTD_COLLECT_INTERVAL=10/);
    assert.match(out, /-e TZ=Europe\/Oslo/);
    assert.doesNotMatch(out, /-e INSIGHTD_LOG_LINES/);
  });

  it('uses provided image override', () => {
    const out = buildDockerCommand(defaults({ image: 'andreas404/insightd-agent:hub-v1.0.0' }));
    assert.match(out, /andreas404\/insightd-agent:hub-v1\.0\.0/);
  });
});
