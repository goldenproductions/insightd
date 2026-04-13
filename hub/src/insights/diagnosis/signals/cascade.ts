/**
 * Cascade signal: ≥50% of the containers on the host are failing, and at
 * least 2 sibling containers are affected — this container is part of a
 * wider outage. Medium confidence, severity=warning.
 */

import type { DiagnosisContext, FindingSignal } from '../types';

export function detectCascade(ctx: DiagnosisContext): FindingSignal | null {
  if (!ctx.coincident.cascadeDetected) return null;
  const { containerName, hostId } = ctx.entity;

  const failures = ctx.coincident.recentFailures;
  const shown = failures.slice(0, 3);
  const more = failures.length > 3 ? ` +${failures.length - 3} more` : '';

  return {
    kind: 'cascade',
    severity: 'warning',
    confidence: 'medium',
    conclusion: `${containerName} is part of a wider failure on ${hostId}`,
    action: `Multiple containers on ${hostId} are affected simultaneously. This is not isolated — investigate host-level issues: network, storage, a shared dependency (database, cache), or a recent host restart.`,
    evidence: [
      `Other containers also failing: ${shown.join(', ')}${more}`,
    ],
    priority: 4,
  };
}

module.exports = { detectCascade };
