import { mock } from 'node:test';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
const {
  DOCKER_CONTAINER_LIST, DOCKER_INSPECT_NO_RESTARTS,
  DOCKER_STATS, DOCKER_IMAGE_INSPECT,
} = require('./fixtures');

interface MockDockerOptions {
  containers?: Array<Record<string, unknown>>;
  inspect?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  imageInspect?: Record<string, unknown>;
}

function createMockDocker(options: MockDockerOptions = {}) {
  const containers = options.containers || DOCKER_CONTAINER_LIST;
  const inspectResult = options.inspect || DOCKER_INSPECT_NO_RESTARTS;
  const statsResult = options.stats || DOCKER_STATS;
  const imageInspect = options.imageInspect || DOCKER_IMAGE_INSPECT;

  return {
    info: async () => ({ Containers: containers.length, Images: containers.length }),
    listContainers: async () => containers,
    getContainer: (_id: string) => ({
      inspect: async () => inspectResult,
      stats: async () => statsResult,
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      remove: async () => {},
    }),
    getImage: (_name: string) => ({
      inspect: async () => imageInspect,
    }),
  };
}

function createMockTransport() {
  return {
    sendMail: mock.fn(async () => ({ messageId: 'test-msg-123' })),
  };
}

function createMockHttpsResponse(statusCode: number, headers?: Record<string, string>, body?: unknown) {
  return (_url: string, _opts: Record<string, unknown>, callback?: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
    res.statusCode = statusCode;
    res.headers = headers || {};

    if (callback) {
      process.nextTick(() => {
        callback(res);
        if (body !== undefined) {
          res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
        }
        res.emit('end');
      });
    }

    const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    req.setTimeout = () => {};
    req.end = () => {};
    req.destroy = () => {};
    return req;
  };
}

// Suppress console output during tests
function suppressConsole(): () => void {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
}

module.exports = { createMockDocker, createMockTransport, createMockHttpsResponse, suppressConsole };
