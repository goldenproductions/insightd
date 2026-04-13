import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { DrainTree, tokenize, hashTemplate } = require('../../hub/src/insights/diagnosis/drain');

describe('drain tokenizer', () => {
  it('masks IPv4 addresses to <*>', () => {
    assert.deepEqual(tokenize('client 10.0.0.7 connected'), ['client', '<*>', 'connected']);
  });

  it('masks IPv4 addresses with ports', () => {
    assert.deepEqual(tokenize('upstream 192.168.1.1:8080 failed'), ['upstream', '<*>', 'failed']);
  });

  it('masks UUIDs', () => {
    assert.deepEqual(
      tokenize('request f47ac10b-58cc-4372-a567-0e02b2c3d479 done'),
      ['request', '<*>', 'done'],
    );
  });

  it('masks hex digests of ≥8 chars', () => {
    assert.deepEqual(tokenize('container deadbeef1234 started'), ['container', '<*>', 'started']);
  });

  it('masks numbers with unit suffixes', () => {
    assert.deepEqual(
      tokenize('response took 47ms for 1.5mb'),
      ['response', 'took', '<*>', 'for', '<*>'],
    );
  });

  it('strips trailing punctuation before masking (comma, period, semicolon)', () => {
    assert.deepEqual(tokenize('port 8080, status 200.'), ['port', '<*>', 'status', '<*>']);
  });

  it('keeps colons so log-level prefixes survive tokenization', () => {
    assert.deepEqual(tokenize('FATAL: cannot bind'), ['FATAL:', 'cannot', 'bind']);
    assert.deepEqual(tokenize('panic: runtime error'), ['panic:', 'runtime', 'error']);
  });

  it('leaves literal words alone', () => {
    assert.deepEqual(
      tokenize('Fatal error cannot bind'),
      ['Fatal', 'error', 'cannot', 'bind'],
    );
  });

  it('masks slashed dates common in syslog-style loggers', () => {
    assert.deepEqual(tokenize('2026/04/13 request received'), ['<*>', 'request', 'received']);
  });

  it('masks clock times with optional fractional seconds', () => {
    assert.deepEqual(tokenize('started at 14:47:54'), ['started', 'at', '<*>']);
    assert.deepEqual(tokenize('started at 14:47:54.325239'), ['started', 'at', '<*>']);
  });

  it('collapses AdGuard-style timestamped logs to a single template', () => {
    const tree = new DrainTree([]);
    // Real log format from adguard/adguardhome.
    const a = tree.match(tokenize('2026/04/13 14:47:54.325239 [error] dnsproxy exchange failed'));
    const b = tree.match(tokenize('2026/04/13 14:52:53.196989 [error] dnsproxy exchange failed'));
    const c = tree.match(tokenize('2026/04/13 15:00:06.699472 [error] dnsproxy exchange failed'));
    assert.equal(a.templateHash, b.templateHash);
    assert.equal(b.templateHash, c.templateHash);
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, false);
    assert.equal(c.isNew, false);
  });
});

describe('drain hashTemplate', () => {
  it('is deterministic across calls', () => {
    const h1 = hashTemplate(['Connected', 'client', '<*>']);
    const h2 = hashTemplate(['Connected', 'client', '<*>']);
    assert.equal(h1, h2);
  });

  it('distinguishes different templates', () => {
    const h1 = hashTemplate(['Connected', 'client', '<*>']);
    const h2 = hashTemplate(['Disconnected', 'client', '<*>']);
    assert.notEqual(h1, h2);
  });
});

describe('drain parse tree', () => {
  it('assigns the same template to similar lines differing only in variables', () => {
    const tree = new DrainTree([]);
    const a = tree.match(tokenize('connection from 10.0.0.1 accepted'));
    const b = tree.match(tokenize('connection from 10.0.0.2 accepted'));
    const c = tree.match(tokenize('connection from 192.168.1.5 accepted'));
    assert.equal(a.templateHash, b.templateHash);
    assert.equal(b.templateHash, c.templateHash);
    // First hit is new, subsequent are merges.
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, false);
    assert.equal(c.isNew, false);
  });

  it('distinguishes different templates', () => {
    const tree = new DrainTree([]);
    const a = tree.match(tokenize('connection accepted from 10.0.0.1'));
    const b = tree.match(tokenize('permission denied for user root'));
    assert.notEqual(a.templateHash, b.templateHash);
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, true);
  });

  it('keeps the tree bounded for high-cardinality inputs', () => {
    const tree = new DrainTree([]);
    // 200 distinct clients should collapse to one template.
    for (let i = 0; i < 200; i++) {
      tree.match(tokenize(`client 10.0.${(i >> 8) & 0xff}.${i & 0xff} connected in ${i}ms`));
    }
    // After 200 lines, we expect at most a handful of templates, not 200.
    const result = tree.match(tokenize('client 10.0.1.99 connected in 42ms'));
    assert.equal(result.isNew, false, 'the 201st line should match an existing template');
  });

  it('seeds from existing templates so new matches hit old hashes', () => {
    const tree1 = new DrainTree([]);
    const first = tree1.match(tokenize('database connection failed for user bob'));
    const seedHash = first.templateHash;
    const seedTemplate = first.template;

    const tree2 = new DrainTree([
      {
        templateHash: seedHash,
        template: seedTemplate,
        tokenCount: seedTemplate.split(' ').length,
        occurrenceCount: 1,
        semanticTag: null,
      },
    ]);
    const second = tree2.match(tokenize('database connection failed for user alice'));
    assert.equal(second.templateHash, seedHash, 'seeded template should match re-loaded tree');
    assert.equal(second.isNew, false);
  });

  it('returns an empty hash for empty input without throwing', () => {
    const tree = new DrainTree([]);
    const result = tree.match([]);
    assert.ok(result);
    assert.equal(result.tokenCount, 0);
  });
});
