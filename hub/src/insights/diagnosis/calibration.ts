/**
 * Confidence calibration from historical feedback.
 *
 * Every time a user hits thumbs-up / thumbs-down on a finding, we log the
 * vote keyed by (diagnoser, conclusion_tag) in `confidence_calibration`.
 * Over time that table accumulates counts of helpful / unhelpful votes
 * per finding type. When a diagnoser emits a new finding we compute a
 * Bayesian posterior estimate of helpfulness from those counts:
 *
 *     p_helpful = (helpful + α) / (helpful + unhelpful + α + β)
 *
 * with a Beta(α=2, β=2) prior — weak enough to shift under 10 real votes
 * but strong enough to prevent "one lucky vote = high confidence".
 *
 * We only override the diagnoser's self-assigned confidence when we have
 * ≥5 feedback samples; below that the historical signal is too noisy to
 * trust.
 */

import type Database from 'better-sqlite3';
import type { Finding } from './types';

const PRIOR_ALPHA = 2;
const PRIOR_BETA = 2;
const MIN_SAMPLES_TO_OVERRIDE = 5;
const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.5;

interface CalibrationRow {
  helpful_count: number;
  unhelpful_count: number;
}

/**
 * Derive a `conclusion_tag` from a finding — the first available signal
 * kind if structured signals are attached, else a canonicalized slug of
 * the conclusion string. Same finding type on the same diagnoser should
 * map to the same tag so feedback accumulates meaningfully.
 */
export function conclusionTag(finding: Finding): string {
  if (finding.signals && finding.signals.length > 0) {
    const primary = finding.signals.find((s) => s.kind !== 'ppr_root');
    if (primary) return primary.kind;
  }
  return finding.conclusion
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 64);
}

/**
 * Compute the Beta posterior estimate of helpfulness.
 */
function pHelpful(helpful: number, unhelpful: number): number {
  return (helpful + PRIOR_ALPHA) / (helpful + unhelpful + PRIOR_ALPHA + PRIOR_BETA);
}

function confidenceFromProbability(p: number): Finding['confidence'] {
  if (p >= HIGH_THRESHOLD) return 'high';
  if (p >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Apply confidence calibration to a list of fresh findings by looking up
 * their historical helpfulness. Does not mutate inputs. Best-effort —
 * returns findings unchanged on any DB error.
 */
export function calibrateFindings(db: Database.Database, findings: Finding[]): Finding[] {
  if (findings.length === 0) return findings;
  let lookup: (diagnoser: string, tag: string) => CalibrationRow | undefined;
  try {
    const stmt = db.prepare(`
      SELECT helpful_count, unhelpful_count
      FROM confidence_calibration
      WHERE diagnoser = ? AND conclusion_tag = ?
    `);
    lookup = (diagnoser, tag) => stmt.get(diagnoser, tag) as CalibrationRow | undefined;
  } catch {
    return findings;
  }

  return findings.map((f) => {
    try {
      const tag = conclusionTag(f);
      const row = lookup(f.diagnoser, tag);
      if (!row) return f;
      const total = row.helpful_count + row.unhelpful_count;
      if (total < MIN_SAMPLES_TO_OVERRIDE) return f;
      const p = pHelpful(row.helpful_count, row.unhelpful_count);
      return { ...f, confidence: confidenceFromProbability(p) };
    } catch {
      return f;
    }
  });
}

/**
 * Record a feedback vote, incrementing the per-(diagnoser, tag) counter
 * used by `calibrateFindings`. Called from the feedback POST endpoint.
 */
export function recordFeedback(
  db: Database.Database,
  diagnoser: string,
  tag: string,
  helpful: boolean,
): void {
  try {
    db.prepare(`
      INSERT INTO confidence_calibration (diagnoser, conclusion_tag, helpful_count, unhelpful_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(diagnoser, conclusion_tag) DO UPDATE SET
        helpful_count = helpful_count + excluded.helpful_count,
        unhelpful_count = unhelpful_count + excluded.unhelpful_count,
        updated_at = datetime('now')
    `).run(diagnoser, tag, helpful ? 1 : 0, helpful ? 0 : 1);
  } catch {
    // Feedback write is best-effort — never break the request path.
  }
}

module.exports = { calibrateFindings, recordFeedback, conclusionTag };
