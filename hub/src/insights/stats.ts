/**
 * Shared statistical primitives for the insights engine.
 *
 * Kept in one module so that baselines, the diagnosis context builder, the
 * S-H-ESD anomaly pass, and later phases (graph RCA, evidence ranking) all
 * use exactly the same math. No external dependencies — all O(n log n) or
 * better and safe to call from the hot path.
 */

/**
 * Median of a numeric array. Mutates the input in-place by sorting.
 * Returns `null` for an empty array.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  if (values.length % 2 === 1) return values[mid]!;
  return (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Median absolute deviation scaled by the Gaussian consistency constant
 * 1.4826 so that, for normal data, `mad` approximates the standard deviation.
 *
 * Returns `null` when there is not enough data; callers should treat `null`
 * as "no MAD available, fall back to P95 heuristics".
 *
 * IMPORTANT: does not mutate the input array — makes a copy of the absolute
 * deviations before sorting, so callers can safely reuse `values`.
 */
export function mad(values: number[], precomputedMedian?: number): number | null {
  if (values.length === 0) return null;
  const m = precomputedMedian ?? median([...values]);
  if (m == null) return null;
  const deviations = values.map((v) => Math.abs(v - m));
  const d = median(deviations);
  if (d == null) return null;
  return d * 1.4826;
}

/**
 * Robust z-score: |value − median| / mad. Returns `null` when mad is null
 * or zero (a degenerate constant series).
 */
export function robustZ(value: number, med: number, madValue: number | null): number | null {
  if (madValue == null || madValue === 0) return null;
  return Math.abs(value - med) / madValue;
}

/**
 * Pearson correlation coefficient between two equally-long series.
 * Returns `null` for empty inputs or constant series (where variance is 0).
 * Used by Phase 3's RCA edge-weight computation.
 */
export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

/**
 * Generalized ESD test for outliers (Rosner 1983). Given residuals, iteratively
 * removes the point with the largest |z-score| (computed with robust median/MAD)
 * and returns the indices that exceed a critical threshold.
 *
 * Simplified for homelab scale: we use a fixed critical multiplier on robust-z
 * instead of computing the exact t-distribution critical value. With
 * `alpha = 0.05` and typical sample sizes of 14–30 days × 24 hours, a
 * robust-z threshold of ~3.5 corresponds to α ≈ 0.05 while staying cheap.
 *
 * @param residuals — the values to test (post-seasonal-decomposition)
 * @param maxOutliers — upper bound on how many anomalies to return
 * @param threshold — critical robust-z to exceed (default 3.5)
 * @returns indices of detected anomalies, in descending order of severity
 */
export function esdTest(
  residuals: number[],
  maxOutliers: number,
  threshold = 3.5,
): number[] {
  if (residuals.length < 5 || maxOutliers <= 0) return [];
  const remaining = residuals.map((v, i) => ({ v, i }));
  const detected: Array<{ i: number; z: number }> = [];

  for (let k = 0; k < maxOutliers && remaining.length >= 3; k++) {
    const values = remaining.map((r) => r.v);
    const med = median([...values]);
    const d = mad(values, med ?? undefined);
    if (med == null || d == null || d === 0) break;
    let bestIdx = -1;
    let bestZ = -Infinity;
    for (let j = 0; j < remaining.length; j++) {
      const z = Math.abs(remaining[j]!.v - med) / d;
      if (z > bestZ) {
        bestZ = z;
        bestIdx = j;
      }
    }
    if (bestIdx < 0 || bestZ < threshold) break;
    detected.push({ i: remaining[bestIdx]!.i, z: bestZ });
    remaining.splice(bestIdx, 1);
  }
  return detected.map((d) => d.i);
}

/**
 * Rolling median with a fixed-length window. For S-H-ESD this is the cheap
 * seasonal estimator: slide a window over the series, emit the window's median
 * at each position. For positions where the window doesn't fit (near the
 * edges), the window shrinks to whatever is available.
 *
 * Not efficient for massive windows (we sort per position), but homelab-scale
 * inputs are ≤500 points so this is fine.
 */
export function rollingMedian(values: number[], window: number): number[] {
  const out: number[] = new Array(values.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    const slice = values.slice(start, end);
    const m = median(slice);
    out[i] = m ?? values[i]!;
  }
  return out;
}

module.exports = {
  median,
  mad,
  robustZ,
  pearson,
  esdTest,
  rollingMedian,
};
