import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const {
  calibrateFindings,
  recordFeedback,
  conclusionTag,
} = require('../../hub/src/insights/diagnosis/calibration');

function makeFinding(overrides: any = {}): any {
  return {
    diagnoser: 'unified',
    severity: 'warning',
    confidence: 'medium',
    conclusion: 'web is crash-looping',
    evidence: [],
    suggestedAction: '',
    signals: [{
      kind: 'crash_loop',
      severity: 'critical',
      confidence: 'high',
      conclusion: 'web is crash-looping',
      action: '',
      evidence: [],
      priority: 3,
    }],
    ...overrides,
  };
}

describe('conclusionTag', () => {
  it('uses the primary signal kind when signals are present', () => {
    const f = makeFinding();
    assert.equal(conclusionTag(f), 'crash_loop');
  });

  it('skips ppr_root signals when selecting the primary', () => {
    const f = makeFinding({
      signals: [
        { kind: 'ppr_root', severity: 'info', confidence: 'medium', conclusion: '', action: '', evidence: [], priority: 100 },
        { kind: 'cascade', severity: 'warning', confidence: 'medium', conclusion: '', action: '', evidence: [], priority: 4 },
      ],
    });
    assert.equal(conclusionTag(f), 'cascade');
  });

  it('falls back to a slugged conclusion when no signals', () => {
    const f = makeFinding({ signals: undefined, conclusion: 'Something Weird!' });
    assert.equal(conclusionTag(f), 'something_weird_');
  });
});

describe('calibrateFindings', () => {
  let db: any;
  let restore: () => void;

  beforeEach(() => {
    restore = suppressConsole();
    db = createTestDb();
  });

  afterEach(() => {
    restore();
    db.close();
  });

  it('returns findings unchanged when there is no calibration history', () => {
    const findings = [makeFinding({ confidence: 'medium' })];
    const out = calibrateFindings(db, findings);
    assert.equal(out[0].confidence, 'medium');
  });

  it('leaves confidence alone when there are fewer than 5 samples', () => {
    // 4 positive votes — not enough to override.
    for (let i = 0; i < 4; i++) recordFeedback(db, 'unified', 'crash_loop', true);
    const findings = [makeFinding({ confidence: 'low' })];
    const out = calibrateFindings(db, findings);
    assert.equal(out[0].confidence, 'low');
  });

  it('upgrades confidence to high after strong positive feedback', () => {
    for (let i = 0; i < 20; i++) recordFeedback(db, 'unified', 'crash_loop', true);
    const findings = [makeFinding({ confidence: 'low' })];
    const out = calibrateFindings(db, findings);
    assert.equal(out[0].confidence, 'high');
  });

  it('downgrades confidence to low after strong negative feedback', () => {
    for (let i = 0; i < 20; i++) recordFeedback(db, 'unified', 'crash_loop', false);
    const findings = [makeFinding({ confidence: 'high' })];
    const out = calibrateFindings(db, findings);
    assert.equal(out[0].confidence, 'low');
  });

  it('mixed feedback stays near medium', () => {
    for (let i = 0; i < 10; i++) recordFeedback(db, 'unified', 'crash_loop', true);
    for (let i = 0; i < 10; i++) recordFeedback(db, 'unified', 'crash_loop', false);
    const findings = [makeFinding({ confidence: 'high' })];
    const out = calibrateFindings(db, findings);
    assert.equal(out[0].confidence, 'medium');
  });

  it('calibration is per-diagnoser-tag pair', () => {
    for (let i = 0; i < 10; i++) recordFeedback(db, 'unified', 'crash_loop', true);
    for (let i = 0; i < 10; i++) recordFeedback(db, 'unified', 'cascade', false);

    const crashy = makeFinding({ confidence: 'low' });
    const cascadey = makeFinding({
      confidence: 'high',
      signals: [{ kind: 'cascade', severity: 'warning', confidence: 'medium', conclusion: '', action: '', evidence: [], priority: 4 }],
    });
    const out = calibrateFindings(db, [crashy, cascadey]);
    assert.equal(out[0].confidence, 'high', 'crash_loop upgrades');
    assert.equal(out[1].confidence, 'low', 'cascade downgrades');
  });
});
