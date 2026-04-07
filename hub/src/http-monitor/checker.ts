import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');
const { getEndpoints, insertCheck, getLastCheck } = require('./queries');

interface HttpEndpoint {
  id: number;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  interval_seconds: number;
  timeout_ms: number;
  headers: string | null;
  enabled: number;
}

interface ProbeResult {
  statusCode: number | null;
  responseTimeMs: number | null;
  isUp: boolean;
  error: string | null;
}

/**
 * Probe a single HTTP endpoint. Returns result object.
 */
async function probeEndpoint(endpoint: HttpEndpoint): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.timeout_ms);

  const headers: Record<string, string> = {};
  if (endpoint.headers) {
    try {
      Object.assign(headers, JSON.parse(endpoint.headers));
    } catch {
      // Invalid JSON headers — skip
    }
  }

  const start = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    const responseTimeMs = Date.now() - start;
    const isUp = response.status === endpoint.expected_status;
    return {
      statusCode: response.status,
      responseTimeMs,
      isUp,
      error: isUp ? null : `Expected ${endpoint.expected_status}, got ${response.status}`,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    let error = (err as Error).message;
    if ((err as any).name === 'AbortError') {
      error = `Timeout after ${endpoint.timeout_ms}ms`;
    }
    return { statusCode: null, responseTimeMs: null, isUp: false, error };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run checks for all enabled endpoints that are due.
 * An endpoint is "due" if enough time has elapsed since its last check.
 */
async function runChecks(db: Database.Database): Promise<void> {
  const endpoints = (getEndpoints(db) as HttpEndpoint[]).filter(ep => ep.enabled);
  if (endpoints.length === 0) return;

  const now = Date.now();
  const due: HttpEndpoint[] = [];

  for (const ep of endpoints) {
    const last = getLastCheck(db, ep.id) as { checked_at: string } | null;
    if (last) {
      const lastTime = new Date(last.checked_at + 'Z').getTime();
      const elapsedSeconds = (now - lastTime) / 1000;
      if (elapsedSeconds < ep.interval_seconds) continue;
    }
    due.push(ep);
  }

  if (due.length === 0) return;

  // Probe in parallel with concurrency limit
  const CONCURRENCY = 10;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(ep => probeEndpoint(ep).then(result => ({ ep, result })))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { ep, result } = r.value;
        insertCheck(db, ep.id, result);
        const status = result.isUp ? 'UP' : 'DOWN';
        logger.info('http-monitor', `${ep.name} (${ep.url}): ${status}${result.responseTimeMs ? ` ${result.responseTimeMs}ms` : ''}${result.error ? ` — ${result.error}` : ''}`);
      } else {
        logger.error('http-monitor', `Check failed unexpectedly: ${r.reason}`);
      }
    }
  }
}

module.exports = { probeEndpoint, runChecks };
