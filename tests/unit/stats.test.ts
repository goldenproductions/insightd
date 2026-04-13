import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { median, mad, robustZ, pearson, esdTest, rollingMedian } = require('../../hub/src/insights/stats');

describe('stats.median', () => {
  it('returns the middle value for odd-length arrays', () => {
    assert.equal(median([1, 2, 3, 4, 5]), 3);
  });

  it('averages the two middle values for even-length arrays', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it('sorts unsorted input', () => {
    assert.equal(median([5, 1, 3, 2, 4]), 3);
  });

  it('returns null for empty input', () => {
    assert.equal(median([]), null);
  });
});

describe('stats.mad', () => {
  it('computes MAD with Gaussian consistency (1.4826)', () => {
    // Values [1, 2, 3, 4, 5] — median 3, deviations [2,1,0,1,2], median dev 1
    // 1.4826 * 1 = 1.4826
    const m = mad([1, 2, 3, 4, 5]);
    assert.ok(Math.abs(m - 1.4826) < 0.001);
  });

  it('returns 0 for a constant series', () => {
    assert.equal(mad([7, 7, 7, 7, 7]), 0);
  });

  it('does not mutate the input array', () => {
    const values = [5, 1, 3, 2, 4];
    const copy = [...values];
    mad(values);
    assert.deepEqual(values, copy);
  });

  it('accepts a precomputed median', () => {
    const values = [1, 2, 3, 4, 5];
    const m1 = mad(values);
    const m2 = mad(values, 3);
    assert.equal(m1, m2);
  });

  it('returns null for empty input', () => {
    assert.equal(mad([]), null);
  });
});

describe('stats.robustZ', () => {
  it('returns deviation in MAD units', () => {
    // (10 − 5) / 2 = 2.5
    assert.equal(robustZ(10, 5, 2), 2.5);
  });

  it('returns null when MAD is 0 (degenerate series)', () => {
    assert.equal(robustZ(10, 5, 0), null);
  });

  it('returns null when MAD is null', () => {
    assert.equal(robustZ(10, 5, null), null);
  });

  it('takes the absolute value (symmetric)', () => {
    assert.equal(robustZ(0, 5, 2), 2.5);
  });
});

describe('stats.pearson', () => {
  it('returns 1 for perfectly correlated series', () => {
    const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    assert.ok(Math.abs(r - 1) < 1e-9);
  });

  it('returns -1 for perfectly anti-correlated series', () => {
    const r = pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    assert.ok(Math.abs(r - -1) < 1e-9);
  });

  it('returns ~0 for uncorrelated series', () => {
    const r = pearson([1, 2, 3, 4, 5], [3, 1, 4, 1, 5]);
    assert.ok(Math.abs(r) < 0.5);
  });

  it('returns null for constant series (variance 0)', () => {
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  });

  it('returns null for mismatched lengths', () => {
    assert.equal(pearson([1, 2, 3], [1, 2]), null);
  });
});

describe('stats.esdTest', () => {
  it('returns empty for too-small input', () => {
    assert.deepEqual(esdTest([1, 2, 3], 2), []);
  });

  it('detects an injected spike in an otherwise quiet series', () => {
    const residuals = [0.1, -0.2, 0.0, 0.1, 50.0, -0.1, 0.2, 0.0, -0.1, 0.1];
    const idx = esdTest(residuals, 2, 3.5);
    assert.ok(idx.includes(4), `expected spike at index 4 in detected set ${idx}`);
  });

  it('respects maxOutliers', () => {
    // Tiny noise so MAD is non-zero; two clear spikes.
    const residuals = [0.1, -0.1, 0.2, -0.2, 100, 0.1, -0.1, 0.2, 200, -0.2];
    const idx = esdTest(residuals, 1, 3.5);
    assert.equal(idx.length, 1);
  });

  it('returns empty when no residual exceeds threshold', () => {
    const residuals = [1, 2, 3, 2, 1, 2, 3, 2, 1, 2];
    const idx = esdTest(residuals, 3, 3.5);
    assert.deepEqual(idx, []);
  });
});

describe('stats.rollingMedian', () => {
  it('returns a series of the same length', () => {
    const out = rollingMedian([1, 2, 3, 4, 5], 3);
    assert.equal(out.length, 5);
  });

  it('smooths a step function', () => {
    const out = rollingMedian([1, 1, 1, 1, 5, 1, 1, 1, 1], 5);
    // The spike at index 4 should be smoothed away by the surrounding 1s.
    assert.ok(out[4]! < 2);
  });

  it('degrades gracefully at the edges', () => {
    const out = rollingMedian([1, 2, 3], 5);
    assert.equal(out.length, 3);
  });
});
