// agent/src/collectors/processes/index.ts
import type { ProcessEventPayload } from '../../../../shared/types/process-events';
import logger = require('../../../../shared/utils/logger');

interface MqttLike {
  connected: boolean;
  publish: (topic: string, payload: string, opts?: { qos: 0 | 1 | 2 }) => void;
}

export interface PublisherOpts {
  mqtt: MqttLike;
  hostId: string;
  bufferMaxCycles: number;
}

export function createPublisher(opts: PublisherOpts) {
  const buffer: ProcessEventPayload[] = [];
  const topic = `insightd/${opts.hostId}/process_events`;

  function flush() {
    while (buffer.length > 0 && opts.mqtt.connected) {
      const head = buffer.shift()!;
      try {
        opts.mqtt.publish(topic, JSON.stringify(head), { qos: 0 });
      } catch (err) {
        logger.warn('processes', `mqtt publish failed: ${(err as Error).message}`);
        buffer.unshift(head);
        return;
      }
    }
  }

  return {
    publish(payload: ProcessEventPayload) {
      buffer.push(payload);
      while (buffer.length > opts.bufferMaxCycles) buffer.shift();
      if (opts.mqtt.connected) flush();
    },
    bufferSize: () => buffer.length,
    peekOldest: () => buffer[0],
    flush,
  };
}
