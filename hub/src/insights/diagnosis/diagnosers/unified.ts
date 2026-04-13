/**
 * Unified diagnoser — replaces the old 9-branch `unhealthy.ts` decision
 * tree with a signal-driven architecture.
 *
 * Pipeline:
 *   1. Run every signal detector against the context. Each returns null or
 *      a typed FindingSignal with its own conclusion / action / evidence
 *      and a priority (lower = more specific).
 *   2. If no signals fire, emit a low-confidence fallback finding so the
 *      user still sees "unhealthy but nothing stood out".
 *   3. Sort fired signals by priority and pick the winner as the finding's
 *      primary conclusion + action + severity + confidence.
 *   4. Build the evidence list: signal-specific evidence first, then a
 *      snapshot of generic context (duration, resources, host state,
 *      logs), then PPR neighbors if graph data is available.
 *   5. Attach all fired signals to `finding.signals` so Phase 4 evidence
 *      ranking and confidence calibration can consume typed data.
 *
 * The new diagnoser *augments* — not discards — the evidence from the old
 * tree: every fact the old diagnoser would have surfaced is still produced
 * by a signal detector. The reorganization unlocks composability (signals
 * can be added / removed independently) and lets Phase 3's PPR results
 * ride through the same Finding shape.
 */

import type Database from 'better-sqlite3';
import type { DiagnosisContext, Finding, FindingSignal, Neighbor } from '../types';
import { bucket, formatDuration } from '../signals/formatters';
import { labelForTag } from '../templateClassifier';

import { detectOom } from '../signals/oom';
import { detectCrashLoop } from '../signals/crashLoop';
import { detectCascade } from '../signals/cascade';
import { detectHostPressure } from '../signals/hostPressure';
import { detectAppErrors } from '../signals/appErrors';
import { detectZombieListener } from '../signals/zombieListener';
import { detectHungService } from '../signals/hungService';

const SIGNAL_DETECTORS = [
  detectOom,
  detectCrashLoop,
  detectCascade,
  detectHostPressure,
  detectAppErrors,
  detectZombieListener,
  detectHungService,
];

export interface UnifiedDiagnoserOptions {
  /**
   * Optional DB handle for loading RCA graph edges. When omitted, the
   * diagnoser runs without PPR neighbors — callers that don't care about
   * graph context (e.g. unit tests for individual signals) can skip it.
   */
  db?: Database.Database;
  /** When true, skip PPR entirely (feature flag — Phase 3 rollout guard). */
  correlationEnabled?: boolean;
}

export function diagnoseUnified(
  ctx: DiagnosisContext,
  options: UnifiedDiagnoserOptions = {},
): Finding[] {
  if (ctx.latest.healthStatus !== 'unhealthy') return [];

  // 1. Collect signals.
  const signals: FindingSignal[] = [];
  for (const detect of SIGNAL_DETECTORS) {
    const s = detect(ctx);
    if (s) signals.push(s);
  }
  signals.sort((a, b) => a.priority - b.priority);

  const { containerName, hostId } = ctx.entity;
  const baseEvidence = buildBaseEvidence(ctx);

  // 2. PPR neighbors (best-effort — never throws).
  const neighbors = runPPR(options, ctx.entity);
  const neighborEvidence = neighbors.length > 0
    ? [formatNeighbors(neighbors)]
    : [];
  if (neighbors.length > 0) {
    signals.push({
      kind: 'ppr_root',
      severity: 'info',
      confidence: 'medium',
      conclusion: `Upstream correlations detected`,
      action: '',
      evidence: [formatNeighbors(neighbors)],
      priority: 100,
    });
  }

  // 3. No signals fired → fallback finding.
  if (signals.length === 0 || signals.every((s) => s.kind === 'ppr_root')) {
    return [{
      diagnoser: 'unified',
      severity: 'warning',
      confidence: 'low',
      conclusion: `${containerName} is reporting unhealthy`,
      evidence: [
        ...(ctx.unhealthy.durationMinutes != null
          ? [`Health check failing for ${formatDuration(ctx.unhealthy.durationMinutes)}`]
          : []),
        ...(ctx.latest.healthCheckOutput
          ? [`Docker reports: ${ctx.latest.healthCheckOutput}`]
          : []),
        ...baseEvidence,
        ...neighborEvidence,
      ],
      suggestedAction: `Nothing obvious stands out in metrics or logs. Check the full container logs for application errors. If the issue persists after a restart, investigate config or upstream dependencies.`,
      signals,
    }];
  }

  // 4. Winner-takes-all: most-specific signal drives the finding.
  const primary = signals.find((s) => s.kind !== 'ppr_root')!;
  const supporting = signals.filter((s) => s !== primary && s.kind !== 'ppr_root');

  const evidence: string[] = [];
  if (ctx.unhealthy.durationMinutes != null) {
    evidence.push(`Health check failing for ${formatDuration(ctx.unhealthy.durationMinutes)}`);
  }
  if (ctx.latest.healthCheckOutput) {
    evidence.push(`Docker reports: ${ctx.latest.healthCheckOutput}`);
  }
  evidence.push(...primary.evidence);
  for (const s of supporting) {
    for (const e of s.evidence) {
      if (!evidence.includes(e)) evidence.push(e);
    }
  }
  evidence.push(...baseEvidence);
  evidence.push(...neighborEvidence);

  return [{
    diagnoser: 'unified',
    severity: primary.severity,
    confidence: primary.confidence,
    conclusion: primary.conclusion,
    evidence,
    suggestedAction: primary.action,
    signals,
  }];
}

/**
 * Generic context evidence that every finding should carry regardless of
 * which signal fired: current resource values vs baseline, restart count,
 * and log summary. These don't drive the conclusion but anchor the user in
 * the entity's current state.
 */
function buildBaseEvidence(ctx: DiagnosisContext): string[] {
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
  if (ctx.latest.cpuPercent != null) {
    const p95 = ctx.baselines.cpu_percent?.p95;
    const comparison = ctx.cpuVsP95 ?? 'unknown';
    if (p95 != null) {
      out.push(`CPU ${comparison} (${bucket(ctx.latest.cpuPercent, 5, '%')}, P95 ${bucket(p95, 5, '%')})`);
    } else {
      out.push(`CPU at ${bucket(ctx.latest.cpuPercent, 5, '%')} (no baseline yet)`);
    }
  }
  if (ctx.recent.restartsInWindow > 0) {
    out.push(`${ctx.recent.restartsInWindow} restart${ctx.recent.restartsInWindow > 1 ? 's' : ''} in the last 2 hours`);
  } else {
    out.push(`No recent restarts`);
  }
  out.push(ctx.host.underPressure
    ? `Host ${ctx.entity.hostId} is under pressure`
    : `Host ${ctx.entity.hostId} is healthy`);

  if (ctx.logs.available) {
    const bursts = ctx.logs.templateBursts ?? [];
    const tags = (ctx.logs.errorPatterns ?? []).map((t) => labelForTag(t) ?? t).slice(0, 3);
    if (bursts.length > 0) {
      const top = bursts.slice(0, 2).map((b) => {
        const label = labelForTag(b.semanticTag);
        return label ? `${label} (×${b.burstCount})` : `"${b.template}" (×${b.burstCount})`;
      });
      out.push(`Recent logs show: ${top.join('; ')}`);
    } else if (tags.length > 0) {
      out.push(`Recent logs show: ${tags.join(', ')}`);
    } else {
      out.push(`Recent logs show no obvious errors`);
    }
  }
  return out;
}

function runPPR(
  options: UnifiedDiagnoserOptions,
  entity: DiagnosisContext['entity'],
): Neighbor[] {
  if (options.correlationEnabled === false || !options.db) return [];
  try {
    const { loadEdges } = require('../../rca/graph') as {
      loadEdges: (db: Database.Database) => any[];
    };
    const { personalizedPageRank } = require('../../rca/ppr') as {
      personalizedPageRank: (edges: any[], seed: string, opts?: any) => { neighbors: Neighbor[] };
    };
    const edges = loadEdges(options.db);
    if (edges.length === 0) return [];
    const seed = `${entity.hostId}/${entity.containerName}`;
    const result = personalizedPageRank(edges, seed, { topK: 3 });
    return result.neighbors;
  } catch {
    return [];
  }
}

function formatNeighbors(neighbors: Neighbor[]): string {
  const top = neighbors.slice(0, 3).map((n) => {
    const types = n.edgeTypes.length > 0 ? ` (${n.edgeTypes.join(', ')})` : '';
    return `${n.entityId}${types}`;
  });
  return `Correlated with: ${top.join('; ')}`;
}

module.exports = { diagnoseUnified };
