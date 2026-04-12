/**
 * Diagnose why a container is unhealthy.
 *
 * Takes a DiagnosisContext (pre-assembled signals) and runs a decision tree
 * to produce a structured Finding. The tree orders from most-specific to
 * least-specific: OOM risk → crash loop → cascade → host pressure →
 * service-level error → zombie listener → generic fallback.
 *
 * The key difference from pattern matching: the same health_check_output
 * produces different diagnoses depending on actual state (memory trend,
 * restart count, host health, other failures, log patterns).
 */

import type { DiagnosisContext, Finding } from '../types';

function round(v: number | null): string {
  if (v == null) return '?';
  return Math.round(v * 10) / 10 + '';
}

/**
 * Bucket a value to a fixed step so small fluctuations don't rewrite
 * evidence strings on every re-run. Returned with a leading `~` so users
 * see at a glance that the number is approximate.
 */
function bucket(v: number | null, step: number, unit: string): string {
  if (v == null) return '?';
  return `~${Math.round(v / step) * step}${unit}`;
}

function formatDuration(minutes: number | null): string {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function diagnoseUnhealthy(ctx: DiagnosisContext): Finding[] {
  if (ctx.latest.healthStatus !== 'unhealthy') return [];

  const { containerName, hostId } = ctx.entity;
  const evidence: string[] = [];

  // --- Build evidence list ---

  if (ctx.unhealthy.since && ctx.unhealthy.durationMinutes != null) {
    evidence.push(`Health check failing for ${formatDuration(ctx.unhealthy.durationMinutes)}`);
  }

  if (ctx.latest.healthCheckOutput) {
    evidence.push(`Docker reports: ${ctx.latest.healthCheckOutput}`);
  }

  // Memory evidence with baseline context. Values are bucketed to 10 MB so
  // minor drifts don't rewrite the sentence on every re-run.
  if (ctx.latest.memoryMb != null) {
    const p95 = ctx.baselines.memory_mb?.p95;
    const comparison = ctx.memoryVsP95 ?? 'unknown';
    if (p95 != null) {
      evidence.push(`Memory ${comparison} (${bucket(ctx.latest.memoryMb, 10, ' MB')}, P95 ${bucket(p95, 10, ' MB')})`);
    } else {
      evidence.push(`Memory at ${bucket(ctx.latest.memoryMb, 10, ' MB')} (no baseline yet)`);
    }
  }

  // CPU evidence with baseline context. Bucketed to 5 %.
  if (ctx.latest.cpuPercent != null) {
    const p95 = ctx.baselines.cpu_percent?.p95;
    const comparison = ctx.cpuVsP95 ?? 'unknown';
    if (p95 != null) {
      evidence.push(`CPU ${comparison} (${bucket(ctx.latest.cpuPercent, 5, '%')}, P95 ${bucket(p95, 5, '%')})`);
    } else {
      evidence.push(`CPU at ${bucket(ctx.latest.cpuPercent, 5, '%')} (no baseline yet)`);
    }
  }

  // Restart evidence
  if (ctx.recent.restartsInWindow > 0) {
    evidence.push(`${ctx.recent.restartsInWindow} restart${ctx.recent.restartsInWindow > 1 ? 's' : ''} in the last 2 hours`);
  } else {
    evidence.push(`No recent restarts`);
  }

  // Host state evidence (also bucketed — host metrics jitter just as much).
  if (ctx.host.underPressure) {
    const parts: string[] = [];
    if (ctx.host.cpuPercent != null && ctx.host.cpuPercent > 80) parts.push(`CPU ${bucket(ctx.host.cpuPercent, 5, '%')}`);
    if (ctx.host.memoryPercent != null && ctx.host.memoryPercent > 85) parts.push(`memory ${bucket(ctx.host.memoryPercent, 5, '%')}`);
    if (ctx.host.load5 != null && ctx.host.load5 > 8) parts.push(`load ${round(ctx.host.load5)}`);
    evidence.push(`Host ${hostId} is under pressure (${parts.join(', ')})`);
  } else {
    evidence.push(`Host ${hostId} is healthy`);
  }

  // Coincident failures
  if (ctx.coincident.recentFailures.length > 0) {
    const shown = ctx.coincident.recentFailures.slice(0, 3);
    const more = ctx.coincident.recentFailures.length > 3 ? ` +${ctx.coincident.recentFailures.length - 3} more` : '';
    evidence.push(`Other containers also failing: ${shown.join(', ')}${more}`);
  }

  // Log patterns
  if (ctx.logs.available) {
    if (ctx.logs.errorPatterns.length > 0) {
      evidence.push(`Recent logs show: ${ctx.logs.errorPatterns.slice(0, 3).join(', ')}`);
    } else {
      evidence.push(`Recent logs show no obvious errors`);
    }
  }

  // --- Decision tree: most specific first ---

  let conclusion: string;
  let action: string;
  let confidence: Finding['confidence'];

  // 1. OOM risk: memory critical AND trending up
  if (ctx.memoryVsP95 === 'critical' && ctx.recent.memoryTrend === 'rising') {
    conclusion = `${containerName} is running out of memory`;
    action = `The process is using significantly more memory than normal and rising. Increase the container's memory limit, investigate for a memory leak, or check \`docker inspect ${containerName}\` for OOMKilled state.`;
    confidence = 'high';
  }
  // 2. OOM confirmed by logs
  else if (ctx.logs.errorPatterns.includes('out of memory')) {
    conclusion = `${containerName} has been killed by the OS for using too much memory`;
    action = `Logs show out-of-memory errors. Increase the container's memory limit or investigate what's allocating memory.`;
    confidence = 'high';
  }
  // 3. Crash loop: multiple restarts and still failing
  else if (ctx.recent.restartsInWindow >= 2) {
    conclusion = `${containerName} is crash-looping`;
    action = `The container has restarted ${ctx.recent.restartsInWindow} times recently but is still failing its health check. Check container logs for the crash cause — if logs show startup errors, inspect config/volumes. If OOM, increase memory limit.`;
    confidence = 'high';
  }
  // 4. Cascade: many containers failing on this host
  else if (ctx.coincident.cascadeDetected) {
    conclusion = `${containerName} is part of a wider failure on ${hostId}`;
    action = `Multiple containers on ${hostId} are affected simultaneously. This is not isolated — investigate host-level issues: network, storage, a shared dependency (database, cache), or a recent host restart.`;
    confidence = 'medium';
  }
  // 5. Host under pressure: container likely starved
  else if (ctx.host.underPressure) {
    conclusion = `${containerName}'s health check is failing while the host is under resource pressure`;
    action = `Host ${hostId} is heavily loaded. The container may be getting starved for CPU or memory. Reduce load on ${hostId} or investigate what else is consuming resources.`;
    confidence = 'medium';
  }
  // 6. Application errors visible in logs, resources stable
  else if (ctx.logs.available && ctx.logs.errorPatterns.length > 0 && ctx.recent.restartsInWindow === 0) {
    const topPattern = ctx.logs.errorPatterns[0]!;
    conclusion = `${containerName} is reporting application errors (${topPattern})`;
    action = `The container is running and resources are normal, but the application is logging errors. Check recent application logs and investigate recent config changes or upstream dependencies.`;
    confidence = 'medium';
  }
  // 7. Connection refused + stable resources = zombie listener
  else if (!ctx.host.underPressure && ctx.recent.restartsInWindow === 0 && ctx.latest.healthCheckOutput?.toLowerCase().includes('refused')) {
    conclusion = `${containerName}'s service port is not responding, but the process is still running with normal resources`;
    action = `This looks like the application's listener crashed independently while the process stayed alive (a zombie listener). Restart the container to recover. If this recurs, it may be a known issue with the application.`;
    confidence = 'medium';
  }
  // 8. Timeout + stable resources = slow/hung service
  else if (ctx.latest.healthCheckOutput?.toLowerCase().match(/timed out|timeout/) && !ctx.host.underPressure) {
    conclusion = `${containerName}'s service is responding too slowly to health checks`;
    action = `The service may be hung, deadlocked, or processing a long-running operation. Check application logs for stuck operations. A restart will clear any stuck state.`;
    confidence = 'medium';
  }
  // 9. Fallback: we know it's unhealthy but nothing stands out
  else {
    conclusion = `${containerName} is reporting unhealthy`;
    action = `Nothing obvious stands out in metrics or logs. Check the full container logs for application errors. If the issue persists after a restart, investigate config or upstream dependencies.`;
    confidence = 'low';
  }

  // Severity: crash loops and OOM are critical; others warning
  const severity: Finding['severity'] =
    confidence === 'high' ? 'critical' : 'warning';

  return [{
    diagnoser: 'unhealthy-container',
    severity,
    confidence,
    conclusion,
    evidence,
    suggestedAction: action,
  }];
}

module.exports = { diagnoseUnhealthy };
