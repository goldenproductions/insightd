import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { classifyTemplate, labelForTag, SEMANTIC_RULES } = require('../../hub/src/insights/diagnosis/templateClassifier');

describe('template classifier', () => {
  it('tags OOM messages', () => {
    assert.equal(classifyTemplate('container killed: out of memory'), 'oom');
    assert.equal(classifyTemplate('OOM-killed process <*>'), 'oom');
    assert.equal(classifyTemplate('cannot allocate memory for buffer'), 'oom');
  });

  it('tags panics', () => {
    assert.equal(classifyTemplate('panic: runtime error: index out of range'), 'panic');
  });

  it('tags segfaults', () => {
    assert.equal(classifyTemplate('segmentation fault at address <*>'), 'segfault');
    assert.equal(classifyTemplate('SIGSEGV received'), 'segfault');
  });

  it('tags connection refusals and resets distinctly', () => {
    assert.equal(classifyTemplate('dial tcp <*>: connection refused'), 'conn_refused');
    assert.equal(classifyTemplate('connection reset by peer'), 'conn_reset');
  });

  it('tags DNS failures', () => {
    assert.equal(classifyTemplate('no such host <*>'), 'dns_fail');
    assert.equal(classifyTemplate('could not resolve <*>'), 'dns_fail');
  });

  it('tags disk full', () => {
    assert.equal(classifyTemplate('write failed: no space left on device'), 'disk_full');
    assert.equal(classifyTemplate('ENOSPC'), 'disk_full');
  });

  it('tags HTTP status codes with word boundaries', () => {
    assert.equal(classifyTemplate('got 502 bad gateway from upstream'), 'http_502');
    assert.equal(classifyTemplate('503 service unavailable'), 'http_503');
  });

  it('does not tag unrelated numbers containing status-like digits', () => {
    // "count=4041" should not match the /\b404\b/ rule — it's not a status.
    assert.equal(classifyTemplate('count=4041 items'), null);
  });

  it('returns null for non-error messages', () => {
    assert.equal(classifyTemplate('starting up'), null);
    assert.equal(classifyTemplate('request completed in <*>'), null);
  });

  it('labelForTag maps tags to human-readable strings', () => {
    assert.equal(labelForTag('oom'), 'out of memory');
    assert.equal(labelForTag('conn_refused'), 'connection refused');
    assert.equal(labelForTag(null), null);
    // Unknown tags pass through.
    assert.equal(labelForTag('mystery'), 'mystery');
  });

  it('has exactly 17 semantic rules (parity with the pre-Drain regexes)', () => {
    assert.equal(SEMANTIC_RULES.length, 17);
  });
});
