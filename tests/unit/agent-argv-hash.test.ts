import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { hashArgv, joinArgv } =
  require('../../agent/src/collectors/processes/argvHash');

describe('hashArgv', () => {
  it('returns 16 hex chars', () => {
    const h = hashArgv(['/bin/ls', '-la']);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    const a = hashArgv(['/bin/ls', '-la']);
    const b = hashArgv(['/bin/ls', '-la']);
    assert.equal(a, b);
  });

  it('distinguishes different argv', () => {
    assert.notEqual(hashArgv(['ls']), hashArgv(['ls', '-la']));
  });

  it('hashes pre-truncation (full string)', () => {
    const short = ['x', 'a'.repeat(5000)];
    const longer = ['x', 'a'.repeat(6000)];
    assert.notEqual(hashArgv(short), hashArgv(longer),
      'hash must use full argv, not truncated form');
  });

  it('joinArgv uses single space separator and preserves args', () => {
    assert.equal(joinArgv(['a', 'b', 'c']), 'a b c');
  });
});
