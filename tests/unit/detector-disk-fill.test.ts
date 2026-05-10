import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { dailyTrend } = require('../../hub/src/insights/disk-fill');

describe('dailyTrend helper', () => {
  it('returns null when fewer than 4 days', () => {
    const daily = [
      { day: '2026-05-04', avg: 50 },
      { day: '2026-05-05', avg: 51 },
      { day: '2026-05-06', avg: 52 },
    ];
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when relative growth < 1% of current', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 1000 + i * 0.5, // 0.5 GB/day on a 1000 GB current = 0.05% — under floor
    }));
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when absolute growth < minimum', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 50 + i * 0.01, // 0.01 GB/day, below 0.05 GB/day floor
    }));
    assert.equal(dailyTrend(daily, 0.05), null);
  });

  it('returns null when fewer than half of day pairs agree with positive trend', () => {
    const daily = [
      { day: 'd1', avg: 50 },
      { day: 'd2', avg: 50 },
      { day: 'd3', avg: 50 },
      { day: 'd4', avg: 50 },
      { day: 'd5', avg: 60 },  // last - first = 10, but only 1/4 days are increasing
    ];
    const out = dailyTrend(daily, 0.05);
    assert.equal(out, null);
  });

  it('returns slope, current, dayCount on a clean rising trend', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      avg: 50 + i * 1, // 1 GB/day
    }));
    const out = dailyTrend(daily, 0.05);
    assert.ok(out);
    assert.equal(out!.dayCount, 7);
    assert.equal(out!.current, 56);
    assert.equal(Math.round(out!.dailyGrowth * 100) / 100, 1);
  });
});
