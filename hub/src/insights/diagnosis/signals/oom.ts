/**
 * OOM detection signal. Fires in three modes (priority order):
 *   1. `oom_confirmed` (kernel) — container_snapshots.last_oom_killed_at is
 *      recent. This is the kernel's own report (Docker State.OOMKilled or
 *      K8s containerStatus terminated.reason==='OOMKilled') so it's the
 *      strongest possible signal — beats log-scraping, beats baselines.
 *   2. `oom_confirmed` (logs) — the log-template semantic overlay (Phase 1)
 *      has identified an 'oom' tag in recent lines. Used when the kernel
 *      signal is missing (e.g. host runtime not capturing it).
 *   3. `oom_risk` — memory is rated critical by the robust-z baseline AND
 *      trending upward. Pre-emptive, high-confidence.
 *
 * All three map to severity=critical in the unified diagnoser's decision tree.
 */

import type { DiagnosisContext, FindingSignal } from '../types';
import { bucket } from './formatters';

const KERNEL_OOM_RECENT_MS = 60 * 60 * 1000; // 1h

export function detectOom(ctx: DiagnosisContext): FindingSignal | null {
  const { containerName } = ctx.entity;

  // Confirmed by the kernel — strongest signal, no false positives.
  const kernelOomAt = ctx.latest.lastOomKilledAt;
  if (kernelOomAt) {
    const ts = Date.parse(kernelOomAt);
    if (Number.isFinite(ts) && ctx.now.getTime() - ts <= KERNEL_OOM_RECENT_MS) {
      const ago = formatAgo(ctx.now.getTime() - ts);
      return {
        kind: 'oom_confirmed',
        severity: 'critical',
        confidence: 'high',
        shortLabel: 'OOM killed',
        conclusion: `${containerName} was killed by the OS for using too much memory`,
        action: `Increase the container's memory limit, or investigate what's allocating memory (memory leak, large request, runaway loop).`,
        evidence: [
          `Kernel reported OOMKilled ${ago}`,
          ...formatMemoryEvidence(ctx),
        ],
        priority: 1,
      };
    }
  }

  // Confirmed by logs — second priority, used when kernel signal is missing.
  if ((ctx.logs.errorPatterns ?? []).includes('oom')) {
    return {
      kind: 'oom_confirmed',
      severity: 'critical',
      confidence: 'high',
      shortLabel: 'OOM killed',
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
      shortLabel: 'OOM risk',
      conclusion: `${containerName} is running out of memory`,
      action: `Memory is significantly above baseline and rising. Increase the container's memory limit, investigate for a memory leak, or check \`docker inspect ${containerName}\` for OOMKilled state.`,
      evidence: formatMemoryEvidence(ctx),
      priority: 2,
    };
  }

  return null;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
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
