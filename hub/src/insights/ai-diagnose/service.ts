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

/**
 * Build the prompt sent to Gemini. Structured as a single user message so
 * we can drive it via generateContent without a system role.
 */
export function buildPrompt(ctx: DiagnosisContext, findings: Finding[]): string {
  const baselinesSummary = Object.entries(ctx.baselines)
    .map(([metric, b]) => `  - ${metric}: p50=${b.p50} p75=${b.p75} p90=${b.p90} p95=${b.p95} p99=${b.p99} (n=${b.sample_count})`)
    .join('\n') || '  (no baselines available)';

  const findingsSummary = findings.length
    ? findings.map((f, i) =>
        `  ${i + 1}. [${f.severity}/${f.confidence}] ${f.conclusion}\n` +
        `     action: ${f.suggestedAction}\n` +
        (f.evidence.length ? `     evidence:\n       - ${f.evidence.join('\n       - ')}` : '')
      ).join('\n')
    : '  (no structured findings produced)';

  const logLines = ctx.logs.available && ctx.logs.lines.length
    ? ctx.logs.lines.slice(-30).map((l) => `  [${l.stream}] ${l.message}`).join('\n')
    : '  (no logs available)';

  const errorPatterns = ctx.logs.errorPatterns.length
    ? ctx.logs.errorPatterns.map((p) => `  - ${p}`).join('\n')
    : '  (none detected)';

  const coincident = ctx.coincident.cascadeDetected
    ? `CASCADE: ${ctx.coincident.recentFailures.join(', ')}`
    : ctx.coincident.recentFailures.length
      ? `Other recent failures: ${ctx.coincident.recentFailures.join(', ')}`
      : 'None';

  return `You are an expert SRE diagnosing a container issue on a self-hosted server. Analyze the signals below and return a JSON object (no prose outside JSON) with exactly these fields:

{
  "rootCause": "one sentence stating the most likely root cause",
  "reasoning": "2-4 sentences explaining how the evidence points there",
  "suggestedFix": "concrete, actionable steps the operator should take",
  "confidence": 0.0 to 1.0,
  "caveats": ["optional list of things you are unsure about or additional data that would help"]
}

CONTAINER
  host: ${ctx.entity.hostId}
  name: ${ctx.entity.containerName}
  now: ${ctx.now.toISOString()}

LATEST SNAPSHOT
  status: ${ctx.latest.status}
  healthStatus: ${ctx.latest.healthStatus ?? 'n/a'}
  healthCheckOutput: ${ctx.latest.healthCheckOutput ?? 'n/a'}
  cpuPercent: ${ctx.latest.cpuPercent ?? 'n/a'}
  memoryMb: ${ctx.latest.memoryMb ?? 'n/a'}
  restartCount: ${ctx.latest.restartCount}
  collectedAt: ${ctx.latest.collectedAt}

RECENT TRENDS (last ~2h)
  cpu: ${ctx.recent.cpuTrend} (vs baseline p95: ${ctx.cpuVsP95 ?? 'n/a'})
  memory: ${ctx.recent.memoryTrend} (vs baseline p95: ${ctx.memoryVsP95 ?? 'n/a'})
  restarts in window: ${ctx.recent.restartsInWindow}

UNHEALTHY EPISODE
  since: ${ctx.unhealthy.since ?? 'n/a'}
  durationMinutes: ${ctx.unhealthy.durationMinutes ?? 'n/a'}

BASELINES (time-of-day percentiles)
${baselinesSummary}

HOST STATE
  healthScore: ${ctx.host.healthScore ?? 'n/a'}
  cpuPercent: ${ctx.host.cpuPercent ?? 'n/a'}
  memoryPercent: ${ctx.host.memoryPercent ?? 'n/a'}
  load5: ${ctx.host.load5 ?? 'n/a'}
  underPressure: ${ctx.host.underPressure}

COINCIDENT SIGNALS
  ${coincident}
  activeAlerts: ${ctx.coincident.activeAlerts.map((a) => a.alert_type + ':' + a.target).join(', ') || 'none'}

LOG ERROR PATTERNS
${errorPatterns}

RECENT LOG LINES
${logLines}

RULE-BASED FINDINGS (from insightd's internal diagnosers)
${findingsSummary}

Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;
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

module.exports = { hashDiagnosisInput, buildPrompt, parseModelJson, callGemini };
