/**
 * Crash-loop signal: the container has restarted ≥2 times in the 2-hour
 * diagnosis window and is still failing its health check. High confidence,
 * severity=critical.
 */

import type { DiagnosisContext, FindingSignal } from '../types';

export function detectCrashLoop(ctx: DiagnosisContext): FindingSignal | null {
  const { containerName } = ctx.entity;
  const restarts = ctx.recent.restartsInWindow;
  if (restarts < 2) return null;

  return {
    kind: 'crash_loop',
    severity: 'critical',
    confidence: 'high',
    shortLabel: 'Crash loop',
    conclusion: `${containerName} is crash-looping`,
    action: `The container has restarted ${restarts} times recently but is still failing its health check. Check container logs for the crash cause — if logs show startup errors, inspect config/volumes. If OOM, increase memory limit.`,
    evidence: [`${restarts} restarts in the last 2 hours`],
    priority: 3,
  };
}

module.exports = { detectCrashLoop };
