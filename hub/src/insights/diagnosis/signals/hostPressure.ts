/**
 * Host-pressure signal: the host this container runs on is itself saturated
 * (CPU >80%, memory >85%, or load-5 >8) while this container is failing.
 * Medium confidence — the container may just be starved rather than broken.
 */

import type { DiagnosisContext, FindingSignal } from '../types';
import { bucket, round } from './formatters';

export function detectHostPressure(ctx: DiagnosisContext): FindingSignal | null {
  if (!ctx.host.underPressure) return null;
  const { containerName, hostId } = ctx.entity;

  const parts: string[] = [];
  if (ctx.host.cpuPercent != null && ctx.host.cpuPercent > 80) parts.push(`CPU ${bucket(ctx.host.cpuPercent, 5, '%')}`);
  if (ctx.host.memoryPercent != null && ctx.host.memoryPercent > 85) parts.push(`memory ${bucket(ctx.host.memoryPercent, 5, '%')}`);
  if (ctx.host.load5 != null && ctx.host.load5 > 8) parts.push(`load ${round(ctx.host.load5)}`);

  return {
    kind: 'host_pressure',
    severity: 'warning',
    confidence: 'medium',
    shortLabel: 'Host under pressure',
    conclusion: `${containerName}'s health check is failing while the host is under resource pressure`,
    action: `Host ${hostId} is heavily loaded. The container may be getting starved for CPU or memory. Reduce load on ${hostId} or investigate what else is consuming resources.`,
    evidence: [`Host ${hostId} is under pressure (${parts.join(', ')})`],
    priority: 5,
  };
}

module.exports = { detectHostPressure };
