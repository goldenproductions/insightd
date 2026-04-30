// Capacity-floor thresholds for the insights pipeline.
//
// Per the project's insights philosophy ("usage is healthy, saturation is the
// problem"), detector alerts and trend predictions only fire when a metric
// crosses an absolute capacity-based ceiling, not when it deviates from
// baseline. These constants are the source of truth for those ceilings.
//
// They are imported by:
//   - hub/src/insights/detector.ts — gates whether alerts fire
//   - hub/src/web/handlers.ts (BaselinesViewer) — drives the
//     "won't alert because below capacity floor" pill in the UI
//
// Keeping these in one place ensures the UI pill cannot drift from detector
// behavior. If you change a threshold, both sides update at once.
//
// Detector alert vs. prediction saturation: the detector alerts when the
// current sustained value crosses the alert threshold. Predictions warn
// earlier — when the trend is *about to* reach saturation within 14 days —
// so they use slightly more conservative ceilings (e.g. load 4 vs alert 8).
// The BaselinesViewer pill uses the prediction (lower) ceilings so it can
// honestly say "below this we won't alert at all" — both detector and
// prediction need the value above their respective ceiling.

// ── Host detector alert thresholds (sustained ≥30 min triggers warning) ─────

/** Host CPU sustained above this percent → warning alert. */
export const HOST_CPU_WARN_PCT = 80;
/** Host CPU sustained above this percent → critical alert. */
export const HOST_CPU_CRIT_PCT = 95;

/** Host memory sustained above this percent of total → warning alert. */
export const HOST_MEMORY_WARN_PCT = 85;
/** Host memory sustained above this percent of total → critical alert. */
export const HOST_MEMORY_CRIT_PCT = 95;

/** Host 5-min load average sustained above this → warning alert. */
export const HOST_LOAD_WARN = 8;
/** Host 5-min load average sustained above this → critical alert. */
export const HOST_LOAD_CRIT = 16;

// ── Host prediction saturation ceilings ─────────────────────────────────────
//
// A prediction fires only when the trend will reach the saturation ceiling
// within 14 days at the current growth rate. These are the lower of the two
// thresholds (alert vs saturation), so the BaselinesViewer pill uses them.

export const HOST_CPU_PREDICTION_SATURATION_PCT = 80;
export const HOST_LOAD_PREDICTION_SATURATION = 4;
/** Memory saturation as a fraction of memory_total_mb (0.8 = 80%). */
export const HOST_MEMORY_PREDICTION_SATURATION_FRACTION = 0.8;

// ── Host week-over-week trend gates ─────────────────────────────────────────

/** WoW host memory growth alert only fires when current usage is at least
 *  this percent of total — prevents "memory critical at 1.4%" from low-
 *  baseline noise. */
export const HOST_MEMORY_WOW_MIN_PCT = 50;

/** WoW host CPU growth alert only fires when current weekly average CPU is
 *  at least this percent — same low-baseline-noise rationale. */
export const HOST_CPU_WOW_MIN_PCT = 40;

// ── Container detector alert thresholds ─────────────────────────────────────

/** Container CPU sustained above this percent (and above its P95) → warning. */
export const CONTAINER_CPU_WARN_PCT = 50;

/** Container memory sustained above P95 by at least this many MB → warning.
 *  Absolute floor on top of the relative-to-P95 check, so a container whose
 *  P95 is 50 MB doesn't alert for routine 60 MB blips. */
export const CONTAINER_MEMORY_OVER_P95_MB = 500;
