/**
 * Zombie-listener signal: the process is running with normal resources, the
 * host is fine, but Docker's health check reports "connection refused" —
 * the application's listener has crashed while the process stays alive.
 * A restart typically recovers.
 */

import type { DiagnosisContext, FindingSignal } from '../types';

export function detectZombieListener(ctx: DiagnosisContext): FindingSignal | null {
  if (ctx.host.underPressure) return null;
  if (ctx.recent.restartsInWindow > 0) return null;
  const out = ctx.latest.healthCheckOutput?.toLowerCase() ?? '';
  if (!out.includes('refused')) return null;
  const { containerName } = ctx.entity;

  return {
    kind: 'zombie_listener',
    severity: 'warning',
    confidence: 'medium',
    conclusion: `${containerName}'s service port is not responding, but the process is still running with normal resources`,
    action: `This looks like the application's listener crashed independently while the process stayed alive (a zombie listener). Restart the container to recover. If this recurs, it may be a known issue with the application.`,
    evidence: [
      `Docker reports: ${ctx.latest.healthCheckOutput}`,
      `No recent restarts; host is healthy`,
    ],
    priority: 7,
  };
}

module.exports = { detectZombieListener };
