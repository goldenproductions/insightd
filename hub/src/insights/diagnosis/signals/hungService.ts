/**
 * Hung-service signal: the health check output mentions a timeout, the host
 * is not under pressure, and the process is alive. The service may be
 * deadlocked or processing a long-running operation.
 */

import type { DiagnosisContext, FindingSignal } from '../types';

export function detectHungService(ctx: DiagnosisContext): FindingSignal | null {
  if (ctx.host.underPressure) return null;
  const out = ctx.latest.healthCheckOutput?.toLowerCase() ?? '';
  if (!/timed out|timeout/.test(out)) return null;
  const { containerName } = ctx.entity;

  return {
    kind: 'hung_service',
    severity: 'warning',
    confidence: 'medium',
    conclusion: `${containerName}'s service is responding too slowly to health checks`,
    action: `The service may be hung, deadlocked, or processing a long-running operation. Check application logs for stuck operations. A restart will clear any stuck state.`,
    evidence: [`Docker reports: ${ctx.latest.healthCheckOutput}`],
    priority: 8,
  };
}

module.exports = { detectHungService };
