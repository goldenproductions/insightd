const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { suppressConsole } = require('../helpers/mocks');

describe('logger', () => {
  let logger;
  let output;
  let restore;

  beforeEach(() => {
    output = { log: [], warn: [], error: [] };
    restore = suppressConsole();
    console.log = (...args) => output.log.push(args.join(' '));
    console.warn = (...args) => output.warn.push(args.join(' '));
    console.error = (...args) => output.error.push(args.join(' '));
    delete require.cache[require.resolve('../../src/utils/logger')];
    logger = require('../../src/utils/logger');
  });

  afterEach(() => {
    restore();
  });

  it('info() logs with correct format', () => {
    logger.info('test', 'hello world');
    assert.equal(output.log.length, 1);
    assert.match(output.log[0], /\[insightd\] INFO \[test\] hello world/);
  });

  it('warn() logs with WARN level', () => {
    logger.warn('test', 'be careful');
    assert.equal(output.warn.length, 1);
    assert.match(output.warn[0], /\[insightd\] WARN \[test\] be careful/);
  });

  it('error() logs with ERROR level', () => {
    logger.error('test', 'something broke');
    assert.equal(output.error.length, 1);
    assert.match(output.error[0], /\[insightd\] ERROR \[test\] something broke/);
  });

  it('error() logs stack trace when error object provided', () => {
    const err = new Error('test error');
    logger.error('test', 'failed', err);
    assert.equal(output.error.length, 2);
    assert.match(output.error[1], /Error: test error/);
  });

  it('error() does not log extra line without error object', () => {
    logger.error('test', 'failed');
    assert.equal(output.error.length, 1);
  });

  it('includes ISO timestamp', () => {
    logger.info('test', 'msg');
    assert.match(output.log[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
