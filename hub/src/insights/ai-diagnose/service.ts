import crypto = require('crypto');
import logger = require('../../../../shared/utils/logger');
import type { DiagnosisContext, Finding } from '../diagnosis/types';

export interface AIDiagnosis {
  rootCause: string;
  reasoning: string;
  suggestedFix: string;
  confidence: number; // 0..1
  caveats: string[];
}

export interface AIDiagnoseCall {
  diagnosis: AIDiagnosis;
  model: string;
  promptTokens: number | null;
  responseTokens: number | null;
  latencyMs: number;
}

export interface AIDiagnoseOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch; // test seam
  now?: () => number;       // test seam
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiRateLimitError extends Error {
  constructor(public retryAfterSeconds: number, message: string) {
    super(message);
    this.name = 'GeminiRateLimitError';
  }
}

/**
 * Parse Google's RetryInfo block from an error response body.
 * Shape: { error: { details: [{ "@type": "...RetryInfo", retryDelay: "32s" }] } }
 */
function parseRetryDelay(body: string): number {
  try {
    const parsed = JSON.parse(body) as { error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> } };
    const details = parsed.error?.details ?? [];
    for (const d of details) {
      if (d['@type']?.includes('RetryInfo') && typeof d.retryDelay === 'string') {
        const m = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return Math.ceil(parseFloat(m[1]!));
      }
    }
  } catch { /* ignore */ }
  return 60; // safe default
}

/**
 * Stable hash of the inputs we send to the model. Used as a cache key: if the
 * context + findings are unchanged, the model answer should also be unchanged.
 */
export function hashDiagnosisInput(ctx: DiagnosisContext, findings: Finding[]): string {
  const canonical = JSON.stringify({
    entity: ctx.entity,
    latest: ctx.latest,
    recent: {
      cpuTrend: ctx.recent.cpuTrend,
      memoryTrend: ctx.recent.memoryTrend,
      restartsInWindow: ctx.recent.restartsInWindow,
    },
    memoryVsP95: ctx.memoryVsP95,
    cpuVsP95: ctx.cpuVsP95,
    unhealthy: ctx.unhealthy,
    host: ctx.host,
    coincident: ctx.coincident,
    logs: {
      available: ctx.logs.available,
      errorPatterns: ctx.logs.errorPatterns,
      lineCount: ctx.logs.lines.length,
    },
    findings: findings.map((f) => ({
      diagnoser: f.diagnoser,
      conclusion: f.conclusion,
      severity: f.severity,
      confidence: f.confidence,
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const MAX_LOG_LINES = 10;
const MAX_LOG_LINE_LEN = 160;

/**
 * Build a compact prompt sent to Gemini. Sections with no signal are
 * omitted entirely to stay well under free-tier token-per-minute limits.
 * Free tier for gemini-2.0-flash is ~10-15k input tokens/min, so we aim
 * for ~500-1500 tokens per call.
 */
export function buildPrompt(ctx: DiagnosisContext, findings: Finding[]): string {
  const sections: string[] = [];

  sections.push(
    `CONTAINER: ${ctx.entity.hostId}/${ctx.entity.containerName} @ ${ctx.now.toISOString()}`
  );

  // Latest snapshot — compact, one line
  const L = ctx.latest;
  sections.push(
    `STATE: status=${L.status} health=${L.healthStatus ?? 'n/a'} cpu=${L.cpuPercent ?? 'n/a'}% mem=${L.memoryMb ?? 'n/a'}MB restarts=${L.restartCount}` +
    (L.healthCheckOutput ? `\nhealthCheckOutput: ${L.healthCheckOutput.slice(0, 240)}` : '')
  );

  // Trends — only if interesting
  const cpuInteresting = ctx.recent.cpuTrend !== 'stable' || ctx.cpuVsP95;
  const memInteresting = ctx.recent.memoryTrend !== 'stable' || ctx.memoryVsP95;
  if (cpuInteresting || memInteresting || ctx.recent.restartsInWindow > 0) {
    const parts: string[] = [];
    if (cpuInteresting) parts.push(`cpu ${ctx.recent.cpuTrend} vsP95=${ctx.cpuVsP95 ?? 'n/a'}`);
    if (memInteresting) parts.push(`mem ${ctx.recent.memoryTrend} vsP95=${ctx.memoryVsP95 ?? 'n/a'}`);
    if (ctx.recent.restartsInWindow > 0) parts.push(`${ctx.recent.restartsInWindow} restarts in 2h`);
    sections.push(`TRENDS: ${parts.join(', ')}`);
  }

  // Unhealthy episode — only if present
  if (ctx.unhealthy.since) {
    sections.push(`UNHEALTHY: since ${ctx.unhealthy.since} (${ctx.unhealthy.durationMinutes}min)`);
  }

  // Key baselines only (cpu + memory) — one line each
  const cpuBl = ctx.baselines.cpu_percent;
  const memBl = ctx.baselines.memory_mb;
  if (cpuBl || memBl) {
    const lines: string[] = [];
    if (cpuBl) lines.push(`cpu_percent p50=${cpuBl.p50} p95=${cpuBl.p95} p99=${cpuBl.p99}`);
    if (memBl) lines.push(`memory_mb p50=${memBl.p50} p95=${memBl.p95} p99=${memBl.p99}`);
    sections.push(`BASELINES: ${lines.join('; ')}`);
  }

  // Host state — only if meaningful
  const H = ctx.host;
  if (H.underPressure || (H.cpuPercent != null && H.cpuPercent > 70) || (H.memoryPercent != null && H.memoryPercent > 80) || (H.load5 != null && H.load5 > 4)) {
    sections.push(
      `HOST: cpu=${H.cpuPercent ?? 'n/a'}% mem=${H.memoryPercent ?? 'n/a'}% load5=${H.load5 ?? 'n/a'} pressure=${H.underPressure}`
    );
  }

  // Coincident — only if there's something
  if (ctx.coincident.recentFailures.length > 0 || ctx.coincident.activeAlerts.length > 0) {
    const parts: string[] = [];
    if (ctx.coincident.cascadeDetected) parts.push(`CASCADE: ${ctx.coincident.recentFailures.join(', ')}`);
    else if (ctx.coincident.recentFailures.length) parts.push(`coincident failures: ${ctx.coincident.recentFailures.join(', ')}`);
    if (ctx.coincident.activeAlerts.length) {
      parts.push(`alerts: ${ctx.coincident.activeAlerts.map((a) => `${a.alert_type}:${a.target}`).join(', ')}`);
    }
    sections.push(`COINCIDENT: ${parts.join('; ')}`);
  }

  // Log error patterns — dedupe + cap
  if (ctx.logs.errorPatterns.length > 0) {
    sections.push(`ERROR PATTERNS: ${ctx.logs.errorPatterns.slice(0, 6).join(' | ')}`);
  }

  // Recent log lines — cap count and per-line length
  if (ctx.logs.available && ctx.logs.lines.length > 0) {
    const lines = ctx.logs.lines
      .slice(-MAX_LOG_LINES)
      .map((l) => {
        const msg = l.message.length > MAX_LOG_LINE_LEN ? l.message.slice(0, MAX_LOG_LINE_LEN) + '…' : l.message;
        return `[${l.stream}] ${msg}`;
      })
      .join('\n');
    sections.push(`LOGS:\n${lines}`);
  }

  // Findings — compact format
  if (findings.length > 0) {
    const lines = findings.map((f, i) => {
      const ev = f.evidence.length ? ` (${f.evidence.slice(0, 3).join('; ')})` : '';
      return `${i + 1}. [${f.severity}/${f.confidence}] ${f.conclusion}${ev}`;
    }).join('\n');
    sections.push(`FINDINGS:\n${lines}`);
  }

  return `You are an SRE diagnosing a container issue. Using only the signals below, return ONLY this JSON (no markdown, no code fences):
{"rootCause":"one sentence","reasoning":"2-4 sentences","suggestedFix":"concrete actionable steps","confidence":0.0-1.0,"caveats":["optional"]}

${sections.join('\n\n')}`;
}

/**
 * Defensive parser for Gemini responses. Accepts either a direct JSON body
 * or a JSON string wrapped in code fences, and tolerates missing fields by
 * falling back to safe defaults.
 */
export function parseModelJson(raw: string): AIDiagnosis {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    throw new Error('AI response was not valid JSON');
  }

  const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
  const rootCause = asString(obj.rootCause).trim();
  const reasoning = asString(obj.reasoning).trim();
  const suggestedFix = asString(obj.suggestedFix).trim();

  if (!rootCause || !reasoning || !suggestedFix) {
    throw new Error('AI response missing required fields (rootCause, reasoning, suggestedFix)');
  }

  let confidence = 0.5;
  if (typeof obj.confidence === 'number' && isFinite(obj.confidence)) {
    confidence = Math.max(0, Math.min(1, obj.confidence));
  }

  const caveats: string[] = Array.isArray(obj.caveats)
    ? (obj.caveats as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  return { rootCause, reasoning, suggestedFix, confidence, caveats };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

export async function callGemini(
  ctx: DiagnosisContext,
  findings: Finding[],
  options: AIDiagnoseOptions,
): Promise<AIDiagnoseCall> {
  if (!options.apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const prompt = buildPrompt(ctx, findings);
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = now();

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const msg = (err as Error).name === 'AbortError'
      ? `Gemini request timed out after ${options.timeoutMs}ms`
      : `Gemini request failed: ${(err as Error).message}`;
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = now() - started;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      const retryAfter = parseRetryDelay(errText);
      throw new GeminiRateLimitError(retryAfter, `Gemini rate-limited, retry in ${retryAfter}s`);
    }
    throw new Error(`Gemini returned ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as GeminiResponse;
  if (json.error) {
    throw new Error(`Gemini error: ${json.error.message || 'unknown'}`);
  }

  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  const diagnosis = parseModelJson(text);

  logger.info('ai-diagnose',
    `Gemini diagnosis for ${ctx.entity.hostId}/${ctx.entity.containerName} in ${latencyMs}ms ` +
    `(tokens: prompt=${json.usageMetadata?.promptTokenCount ?? '?'}, response=${json.usageMetadata?.candidatesTokenCount ?? '?'})`
  );

  return {
    diagnosis,
    model: options.model,
    promptTokens: json.usageMetadata?.promptTokenCount ?? null,
    responseTokens: json.usageMetadata?.candidatesTokenCount ?? null,
    latencyMs,
  };
}

module.exports = { hashDiagnosisInput, buildPrompt, parseModelJson, callGemini, GeminiRateLimitError };
