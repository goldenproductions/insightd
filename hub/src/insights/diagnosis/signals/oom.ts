/**
 * OOM detection signal. Fires in two modes:
 *   1. `oom_risk` — memory is rated critical by the robust-z baseline AND
 *      trending upward. Pre-emptive, high-confidence.
 *   2. `oom_confirmed` — the log-template semantic overlay (Phase 1) has
 *      identified an 'oom' tag in recent lines. Confirmed, high-confidence.
 *
 * Both map to severity=critical in the unified diagnoser's decision tree.
 */

import type { DiagnosisContext, FindingSignal } from '../types';
import { bucket } from './formatters';

export function detectOom(ctx: DiagnosisContext): FindingSignal | null {
  const { containerName } = ctx.entity;

  // Confirmed by logs — highest priority.
  if ((ctx.logs.errorPatterns ?? []).includes('oom')) {
    return {
      kind: 'oom_confirmed',
      severity: 'critical',
      confidence: 'high',
      conclusion: `${containerName} has been killed by the OS for using too much memory`,
      action: `Logs show out-of-memory errors. Increase the container's memory limit or investigate what's allocating memory.`,
      evidence: [
        `Recent logs contain out-of-memory errors`,
        ...formatMemoryEvidence(ctx),
      ],
      priority: 1,
    };
  }

  // Pre-emptive risk — memory critical AND rising.
  if (ctx.memoryVsP95 === 'critical' && ctx.recent.memoryTrend === 'rising') {
    return {
      kind: 'oom_risk',
      severity: 'critical',
      confidence: 'high',
      conclusion: `${containerName} is running out of memory`,
      action: `Memory is significantly above baseline and rising. Increase the container's memory limit, investigate for a memory leak, or check \`docker inspect ${containerName}\` for OOMKilled state.`,
      evidence: formatMemoryEvidence(ctx),
      priority: 2,
    };
  }

  return null;
}

function formatMemoryEvidence(ctx: DiagnosisContext): string[] {
  const out: string[] = [];
  if (ctx.latest.memoryMb != null) {
    const p95 = ctx.baselines.memory_mb?.p95;
    const comparison = ctx.memoryVsP95 ?? 'unknown';
    if (p95 != null) {
      out.push(`Memory ${comparison} (${bucket(ctx.latest.memoryMb, 10, ' MB')}, P95 ${bucket(p95, 10, ' MB')})`);
    } else {
      out.push(`Memory at ${bucket(ctx.latest.memoryMb, 10, ' MB')} (no baseline yet)`);
    }
  }
  return out;
}

module.exports = { detectOom };
