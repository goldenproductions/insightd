/**
 * App-errors signal: the container has not restarted and its host is not
 * under pressure, but its logs contain known error patterns (via the
 * Phase 1 Drain semantic overlay). The container is "running but sad".
 */

import type { DiagnosisContext, FindingSignal } from '../types';
import { labelForTag } from '../templateClassifier';

export function detectAppErrors(ctx: DiagnosisContext): FindingSignal | null {
  if (!ctx.logs.available) return null;
  if (ctx.recent.restartsInWindow > 0) return null;
  const tags = ctx.logs.errorPatterns ?? [];
  if (tags.length === 0) return null;

  const topTag = tags[0]!;
  const topLabel = labelForTag(topTag) ?? topTag;
  const { containerName } = ctx.entity;

  const bursts = ctx.logs.templateBursts ?? [];
  const burstEvidence: string[] = bursts.slice(0, 2).map((b) => {
    const label = labelForTag(b.semanticTag);
    return label ? `${label} (×${b.burstCount})` : `"${b.template}" (×${b.burstCount})`;
  });

  return {
    kind: 'app_errors',
    severity: 'warning',
    confidence: 'medium',
    shortLabel: `App errors: ${topLabel}`,
    conclusion: `${containerName} is reporting application errors (${topLabel})`,
    action: `The container is running and resources are normal, but the application is logging errors. Check recent application logs and investigate recent config changes or upstream dependencies.`,
    evidence: burstEvidence.length > 0
      ? [`Recent logs show: ${burstEvidence.join('; ')}`]
      : [`Recent logs show: ${tags.slice(0, 3).map((t) => labelForTag(t) ?? t).join(', ')}`],
    priority: 6,
  };
}

module.exports = { detectAppErrors };
