import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { suppressConsole } = require('../helpers/mocks');

describe('safeCollect', () => {
  let safeCollect: Function;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    delete require.cache[require.resolve('../../src/utils/errors')];
    delete require.cache[require.resolve('../../src/utils/logger')];
    safeCollect = require('../../src/utils/errors').safeCollect;
  });

  afterEach(() => {
    restore();
  });

  it('returns result on success', async () => {
    const result = await safeCollect('test', () => 42);
    assert.equal(result, 42);
  });

  it('returns result from async function', async () => {
    const result = await safeCollect('test', async () => 'hello');
    assert.equal(result, 'hello');
  });

  it('returns null when function throws', async () => {
    const result = await safeCollect('test', () => { throw new Error('boom'); });
    assert.equal(result, null);
  });

  it('returns null when async function rejects', async () => {
    const result = await safeCollect('test', async () => { throw new Error('async boom'); });
    assert.equal(result, null);
  });

  it('does not throw on failure', async () => {
    await assert.doesNotReject(
      safeCollect('test', () => { throw new Error('boom'); })
    );
  });
});
