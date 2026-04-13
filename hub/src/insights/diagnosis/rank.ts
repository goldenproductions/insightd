/**
 * Adtributor-style evidence ranker.
 *
 * Based on Bhagwan et al., "Adtributor: Revenue Debugging in Advertising
 * Systems" (NSDI 2014). The core idea is to rank each piece of evidence by:
 *
 *     score = surprise × explanatoryPower
 *
 * where surprise is how unusual the signal is (distance from normal in
 * MAD units, burst intensity, or a fixed value for binary signals) and
 * explanatoryPower is the fraction of total surprise the signal accounts
 * for. This catches cases like "10 small issues" vs "1 huge issue": the
 * huge issue's share of total surprise is dominant, while the small ones
 * are individually below-threshold — so the user sees the top culprits.
 *
 * At homelab scale we only return the top 3; the full evidence list stays
 * in `finding.evidence` for users who expand the "show all" disclosure.
 */

import type { FindingSignal, RankedEvidence } from './types';

const TOP_K = 3;

/**
 * Fixed surprise values for signal kinds whose intensity is binary
 * (they either fired or didn't). Tuned so they rank roughly in the same
 * ballpark as metric-based surprise (which typically lands in 2–6 MAD).
 */
const BINARY_SURPRISE: Record<FindingSignal['kind'], number> = {
  oom_confirmed: 5.0,
  oom_risk: 4.0,
  crash_loop: 5.0,
  cascade: 3.5,
  host_pressure: 3.0,
  app_errors: 2.5,
  zombie_listener: 3.0,
  hung_service: 3.0,
  ppr_root: 1.5,
  fallback: 1.0,
};

/**
 * Estimate surprise for a signal. Today this is a simple function of the
 * signal kind; Phase 4's follow-up work can refine it using typed data
 * embedded in the signal (e.g. memory MAD deviation for oom_risk).
 */
function surpriseOf(signal: FindingSignal): number {
  const kindSurprise = BINARY_SURPRISE[signal.kind] ?? 1.0;
  // Confidence bumps the signal — 'high' is worth more than 'low'.
  const confMult = signal.confidence === 'high' ? 1.3
    : signal.confidence === 'medium' ? 1.0
    : 0.7;
  return kindSurprise * confMult;
}

/**
 * Rank a list of structured signals into top-K evidence items. Each entry
 * gets an explanatory-power share computed against the total surprise
 * across every fired signal.
 */
export function rankEvidence(signals: FindingSignal[]): RankedEvidence[] {
  if (signals.length === 0) return [];
  const scored = signals.map((s) => ({ signal: s, surprise: surpriseOf(s) }));
  const total = scored.reduce((acc, s) => acc + s.surprise, 0);
  if (total === 0) return [];

  const ranked: RankedEvidence[] = scored.map(({ signal, surprise }) => {
    const explanatoryPower = surprise / total;
    return {
      kind: signal.kind,
      label: signal.conclusion,
      surprise: Math.round(surprise * 100) / 100,
      explanatoryPower: Math.round(explanatoryPower * 100) / 100,
      score: Math.round(surprise * explanatoryPower * 100) / 100,
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, TOP_K);
}

module.exports = { rankEvidence };
