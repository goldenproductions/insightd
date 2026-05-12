// tests/unit/agent-process-mqtt-buffer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { createPublisher } =
  require('../../agent/src/collectors/processes/index');

describe('process-event publisher with buffer', () => {
  it('publishes through when MQTT connected', () => {
    const sent: any[] = [];
    const mqtt = {
      connected: true,
      publish: (topic: string, payload: string) => sent.push({ topic, payload }),
    };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 5 });
    pub.publish({ cycle_at: 'n', argv_defs: [], spawns: [], exits: [] });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, 'insightd/h1/process_events');
  });

  it('buffers when disconnected, flushes on next publish after reconnect', () => {
    const sent: any[] = [];
    const mqtt = { connected: false, publish: (t: string, p: string) => sent.push({ t, p }) };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 5 });
    pub.publish({ cycle_at: 'A', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: 'B', argv_defs: [], spawns: [], exits: [] });
    assert.equal(sent.length, 0);
    assert.equal(pub.bufferSize(), 2);

    mqtt.connected = true;
    pub.publish({ cycle_at: 'C', argv_defs: [], spawns: [], exits: [] });
    assert.equal(sent.length, 3);
    assert.equal(JSON.parse(sent[0].p).cycle_at, 'A');
    assert.equal(JSON.parse(sent[2].p).cycle_at, 'C');
  });

  it('evicts oldest cycles when buffer overflows', () => {
    const mqtt = { connected: false, publish: () => {} };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 2 });
    pub.publish({ cycle_at: '1', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: '2', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: '3', argv_defs: [], spawns: [], exits: [] });
    assert.equal(pub.bufferSize(), 2);
    const oldest = pub.peekOldest();
    assert.equal(oldest.cycle_at, '2');
  });
});
