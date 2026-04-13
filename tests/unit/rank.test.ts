import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { rankEvidence } = require('../../hub/src/insights/diagnosis/rank');

function signal(kind: string, confidence: string = 'medium'): any {
  return {
    kind,
    severity: 'warning',
    confidence,
    conclusion: `${kind} detected`,
    action: '',
    evidence: [],
    priority: 1,
  };
}

describe('rankEvidence', () => {
  it('returns empty for no signals', () => {
    assert.deepEqual(rankEvidence([]), []);
  });

  it('returns at most 3 items', () => {
    const signals = ['oom_risk', 'crash_loop', 'cascade', 'host_pressure', 'app_errors'].map((k) => signal(k));
    const ranked = rankEvidence(signals);
    assert.equal(ranked.length, 3);
  });

  it('scores oom_confirmed above app_errors (higher intrinsic surprise)', () => {
    const signals = [signal('oom_confirmed', 'high'), signal('app_errors', 'medium')];
    const ranked = rankEvidence(signals);
    assert.equal(ranked[0]!.kind, 'oom_confirmed');
  });

  it('high confidence boosts the score vs medium', () => {
    const highRanked = rankEvidence([signal('cascade', 'high')]);
    const lowRanked = rankEvidence([signal('cascade', 'low')]);
    assert.ok(highRanked[0]!.surprise > lowRanked[0]!.surprise);
  });

  it('explanatoryPower sums to 1 across all fired signals', () => {
    const signals = [signal('cascade'), signal('app_errors'), signal('host_pressure')];
    const ranked = rankEvidence(signals);
    const sum = ranked.reduce((acc: number, r: any) => acc + r.explanatoryPower, 0);
    // Rounded to 2dp, should be close to 1.0 (not exactly because of rounding).
    assert.ok(Math.abs(sum - 1.0) < 0.05);
  });

  it('each item has score = surprise × explanatoryPower (within rounding)', () => {
    const signals = [signal('oom_risk', 'high'), signal('cascade', 'medium')];
    const ranked = rankEvidence(signals);
    for (const r of ranked) {
      const expected = Math.round(r.surprise * r.explanatoryPower * 100) / 100;
      assert.ok(Math.abs(r.score - expected) < 0.02,
        `score ${r.score} should match surprise×explanatoryPower = ${expected} for ${r.kind}`);
    }
  });
});
