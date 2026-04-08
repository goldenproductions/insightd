const { mock } = require('node:test');
const { EventEmitter } = require('events');
const {
  DOCKER_CONTAINER_LIST, DOCKER_INSPECT_NO_RESTARTS,
  DOCKER_STATS, DOCKER_IMAGE_INSPECT,
} = require('./fixtures');

function createMockDocker(options = {}) {
  const containers = options.containers || DOCKER_CONTAINER_LIST;
  const inspectResult = options.inspect || DOCKER_INSPECT_NO_RESTARTS;
  const statsResult = options.stats || DOCKER_STATS;
  const imageInspect = options.imageInspect || DOCKER_IMAGE_INSPECT;

  return {
    info: async () => ({ Containers: containers.length, Images: containers.length }),
    listContainers: async () => containers,
    getContainer: (id) => ({
      inspect: async () => inspectResult,
      stats: async () => statsResult,
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      remove: async () => {},
    }),
    getImage: (name) => ({
      inspect: async () => imageInspect,
    }),
  };
}

function createMockTransport() {
  return {
    sendMail: mock.fn(async () => ({ messageId: 'test-msg-123' })),
  };
}

function createMockHttpsResponse(statusCode, headers, body) {
  return (url, opts, callback) => {
    const res = new EventEmitter();
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

    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {};
    req.destroy = () => {};
    return req;
  };
}

// Suppress console output during tests
function suppressConsole() {
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
