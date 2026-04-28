import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractOomKilledAt } = require('../../agent/src/runtime/docker');

describe('extractOomKilledAt', () => {
  it('returns null when OOMKilled is false', () => {
    assert.equal(extractOomKilledAt({ State: { OOMKilled: false, FinishedAt: '2026-04-28T10:00:00Z' } }), null);
  });

  it('returns null when State is missing', () => {
    assert.equal(extractOomKilledAt({}), null);
    assert.equal(extractOomKilledAt(null), null);
  });

  it('returns FinishedAt when OOMKilled is true', () => {
    const ts = '2026-04-28T10:00:00Z';
    assert.equal(extractOomKilledAt({ State: { OOMKilled: true, FinishedAt: ts } }), ts);
  });

  it('falls back to "now" when FinishedAt is the Docker-zero placeholder', () => {
    // Docker reports "0001-01-01T00:00:00Z" for containers that never exited.
    // Such a value is meaningless as a timestamp, so we substitute "now" so
    // the kernel signal still travels to the hub.
    const out = extractOomKilledAt({ State: { OOMKilled: true, FinishedAt: '0001-01-01T00:00:00Z' } });
    assert.ok(out);
    assert.ok(Math.abs(Date.now() - Date.parse(out!)) < 5000);
  });

  it('falls back to "now" when FinishedAt is missing entirely', () => {
    const out = extractOomKilledAt({ State: { OOMKilled: true } });
    assert.ok(out);
    assert.ok(Math.abs(Date.now() - Date.parse(out!)) < 5000);
  });
});
