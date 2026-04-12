/**
 * Interpret Docker health check output into a plain-language diagnosis.
 * Shared between insights detector and container detail API so users see
 * a helpful explanation immediately, not just raw wget/curl output.
 */
export function diagnoseHealthCheck(containerName: string, output: string | null): string {
  if (!output) {
    return `${containerName} is reporting unhealthy but no diagnostic output is available. Check container logs for details.`;
  }

  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();

  if (lower.includes('connection refused')) {
    return `${containerName}'s health check cannot connect to the service — the main process may have crashed or is not listening on the expected port. Consider restarting the container.`;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return `${containerName}'s health check is timing out — the service may be overloaded or unresponsive. Check CPU and memory usage on this host.`;
  }
  if (lower.match(/\b(502|503|504)\b/)) {
    return `${containerName}'s health check is getting server errors — the service is running but unable to handle requests. Check application logs.`;
  }
  if (lower.match(/\b(401|403)\b/)) {
    return `${containerName}'s health check is being rejected with an auth error — the health check endpoint may require credentials or the configuration has changed.`;
  }
  if (lower.match(/\b404\b/)) {
    return `${containerName}'s health check endpoint is returning 404 — the health check URL may be misconfigured or the application hasn't started fully.`;
  }
  if (lower.includes('name or service not known') || lower.includes('could not resolve') || lower.includes('dns')) {
    return `${containerName}'s health check is failing due to DNS resolution — the container cannot resolve hostnames. Check DNS configuration and network connectivity.`;
  }
  if (lower.includes('oom') || lower.includes('killed') || lower.includes('exit code 137')) {
    return `${containerName} appears to be running out of memory — the process is being killed by the OS. Consider increasing the container's memory limit.`;
  }
  if (lower.includes('no such file') || lower.includes('not found') || lower.includes('command not found')) {
    return `${containerName}'s health check command is failing — the health check binary or script may be missing from the container image.`;
  }

  return `${containerName}'s health check is failing. Check container logs for more details.`;
}

module.exports = { diagnoseHealthCheck };
