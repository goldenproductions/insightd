import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createTestDb } = require('../helpers/db');
const { suppressConsole } = require('../helpers/mocks');
const {
  hashDiagnosisInput,
  buildPrompt,
  parseModelJson,
  callGemini,
  GeminiRateLimitError,
} = require('../../hub/src/insights/ai-diagnose/service');
const {
  getLatestDiagnosis,
  insertDiagnosis,
  rowToJson,
} = require('../../hub/src/insights/ai-diagnose/queries');

function makeCtx(overrides: any = {}): any {
  return {
    entity: { type: 'container', hostId: 'h1', containerName: 'nginx' },
    now: new Date('2026-04-12T10:00:00Z'),
    latest: {
      status: 'running',
      cpuPercent: 42,
      memoryMb: 512,
      restartCount: 3,
      healthStatus: 'unhealthy',
      healthCheckOutput: 'curl: (7) Failed to connect',
      collectedAt: '2026-04-12 09:59:00',
    },
    recent: {
      snapshots: [],
      cpuTrend: 'rising',
      memoryTrend: 'stable',
      restartsInWindow: 2,
    },
    baselines: {
      cpu_percent: { metric: 'cpu_percent', p50: 10, p75: 15, p90: 20, p95: 25, p99: 30, sample_count: 500 },
    },
    memoryVsP95: 'elevated',
    cpuVsP95: 'critical',
    unhealthy: { since: '2026-04-12 09:40:00', durationMinutes: 19 },
    host: { healthScore: 70, cpuPercent: 65, memoryPercent: 80, load5: 3.2, underPressure: true },
    coincident: { activeAlerts: [], recentFailures: ['redis'], cascadeDetected: false },
    logs: {
      available: true,
      lines: [
        { stream: 'stderr', timestamp: null, message: 'Connection refused on upstream' },
      ],
      errorPatterns: ['Connection refused'],
      fetchedAt: '2026-04-12 09:58:00',
    },
    ...overrides,
  };
}

const SAMPLE_FINDINGS = [
  {
    diagnoser: 'unhealthy',
    severity: 'warning',
    confidence: 'high',
    conclusion: 'Upstream dependency is unreachable',
    evidence: ['Log pattern: Connection refused', 'Coincident failure: redis'],
    suggestedAction: 'Verify redis connectivity and restart nginx',
  },
];

describe('ai-diagnose: hashDiagnosisInput', () => {
  it('produces stable hashes for equivalent inputs', () => {
    const a = hashDiagnosisInput(makeCtx(), SAMPLE_FINDINGS);
    const b = hashDiagnosisInput(makeCtx(), SAMPLE_FINDINGS);
    assert.equal(a, b);
  });

  it('changes when latest metrics change', () => {
    const a = hashDiagnosisInput(makeCtx(), SAMPLE_FINDINGS);
    const b = hashDiagnosisInput(
      makeCtx({ latest: { ...makeCtx().latest, cpuPercent: 99 } }),
      SAMPLE_FINDINGS,
    );
    assert.notEqual(a, b);
  });

  it('changes when findings change', () => {
    const a = hashDiagnosisInput(makeCtx(), SAMPLE_FINDINGS);
    const b = hashDiagnosisInput(makeCtx(), [
      { ...SAMPLE_FINDINGS[0], conclusion: 'Different conclusion' },
    ]);
    assert.notEqual(a, b);
  });
});

describe('ai-diagnose: buildPrompt', () => {
  it('includes key context fields and findings', () => {
    const prompt = buildPrompt(makeCtx(), SAMPLE_FINDINGS);
    assert.match(prompt, /nginx/);
    assert.match(prompt, /unhealthy/);
    assert.match(prompt, /Connection refused/);
    assert.match(prompt, /Upstream dependency is unreachable/);
    assert.match(prompt, /rootCause/);
    assert.match(prompt, /ONLY this JSON/i);
  });

  it('omits empty sections for a quiet container', () => {
    const ctx = makeCtx({
      recent: { snapshots: [], cpuTrend: 'stable', memoryTrend: 'stable', restartsInWindow: 0 },
      memoryVsP95: null,
      cpuVsP95: null,
      unhealthy: { since: null, durationMinutes: null },
      host: { healthScore: 95, cpuPercent: 10, memoryPercent: 20, load5: 0.5, underPressure: false },
      coincident: { activeAlerts: [], recentFailures: [], cascadeDetected: false },
      logs: { available: false, lines: [], errorPatterns: [], fetchedAt: null },
    });
    const prompt = buildPrompt(ctx, []);
    // Required sections
    assert.match(prompt, /CONTAINER:/);
    assert.match(prompt, /STATE:/);
    // Omitted sections should not appear
    assert.doesNotMatch(prompt, /TRENDS:/);
    assert.doesNotMatch(prompt, /UNHEALTHY:/);
    assert.doesNotMatch(prompt, /HOST:/);
    assert.doesNotMatch(prompt, /COINCIDENT:/);
    assert.doesNotMatch(prompt, /LOGS:/);
    assert.doesNotMatch(prompt, /FINDINGS:/);
    assert.doesNotMatch(prompt, /ERROR PATTERNS:/);
  });

  it('caps log lines at 10 and truncates long lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      stream: 'stderr' as const, timestamp: null,
      message: `line${i} ` + 'x'.repeat(300),
    }));
    const ctx = makeCtx({
      logs: { available: true, lines, errorPatterns: [], fetchedAt: '2026-04-12 09:58:00' },
    });
    const prompt = buildPrompt(ctx, []);
    const logMatches = prompt.match(/\[stderr\]/g) ?? [];
    assert.equal(logMatches.length, 10);
    assert.match(prompt, /…/); // truncation ellipsis
    assert.doesNotMatch(prompt, /x{200}/); // no 200+ char runs survive
  });

  it('is meaningfully shorter than the old verbose format', () => {
    const prompt = buildPrompt(makeCtx(), SAMPLE_FINDINGS);
    // Sanity check — full prompt for typical input should be well under 2KB
    assert.ok(prompt.length < 2000, `prompt too long: ${prompt.length} chars`);
  });
});

describe('ai-diagnose: parseModelJson', () => {
  it('parses a clean JSON response', () => {
    const d = parseModelJson(JSON.stringify({
      rootCause: 'Upstream unreachable',
      reasoning: 'Logs show connection refused coincident with redis failure.',
      suggestedFix: 'Check redis and restart nginx.',
      confidence: 0.8,
      caveats: ['Could also be DNS'],
    }));
    assert.equal(d.rootCause, 'Upstream unreachable');
    assert.equal(d.confidence, 0.8);
    assert.deepEqual(d.caveats, ['Could also be DNS']);
  });

  it('strips code fences', () => {
    const wrapped = '```json\n' + JSON.stringify({
      rootCause: 'x', reasoning: 'y', suggestedFix: 'z',
    }) + '\n```';
    const d = parseModelJson(wrapped);
    assert.equal(d.rootCause, 'x');
    assert.equal(d.confidence, 0.5); // default when missing
    assert.deepEqual(d.caveats, []);
  });

  it('clamps confidence into [0,1]', () => {
    const d = parseModelJson(JSON.stringify({
      rootCause: 'a', reasoning: 'b', suggestedFix: 'c', confidence: 2.5,
    }));
    assert.equal(d.confidence, 1);
  });

  it('throws on missing required fields', () => {
    assert.throws(() => parseModelJson(JSON.stringify({ rootCause: 'only this' })), /missing required fields/);
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => parseModelJson('not json at all'), /not valid JSON/);
  });

  it('filters non-string caveats', () => {
    const d = parseModelJson(JSON.stringify({
      rootCause: 'a', reasoning: 'b', suggestedFix: 'c',
      caveats: ['valid', 42, null, 'also valid'],
    }));
    assert.deepEqual(d.caveats, ['valid', 'also valid']);
  });
});

describe('ai-diagnose: callGemini', () => {
  let restore: () => void;
  beforeEach(() => { restore = suppressConsole(); });
  afterEach(() => { restore(); });

  it('sends prompt and parses successful response', async () => {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          rootCause: 'Network loss', reasoning: 'Logs indicate upstream refused.', suggestedFix: 'Restart upstream.',
          confidence: 0.9, caveats: [],
        }) }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await callGemini(makeCtx(), SAMPLE_FINDINGS, {
      apiKey: 'test-key', model: 'gemini-2.0-flash', timeoutMs: 5000, fetchImpl: fakeFetch,
    });

    assert.equal(result.diagnosis.rootCause, 'Network loss');
    assert.equal(result.model, 'gemini-2.0-flash');
    assert.equal(result.promptTokens, 120);
    assert.equal(result.responseTokens, 45);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /gemini-2\.0-flash:generateContent\?key=test-key$/);
    const body = JSON.parse(calls[0].init.body);
    assert.ok(body.contents[0].parts[0].text.includes('nginx'));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  });

  it('throws when apiKey is missing', async () => {
    await assert.rejects(
      () => callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: '', model: 'gemini-2.0-flash', timeoutMs: 5000, fetchImpl: async () => new Response('', { status: 200 }),
      }),
      /not configured/,
    );
  });

  it('throws on non-ok HTTP status', async () => {
    const fakeFetch = async () => new Response('server error', { status: 500 });
    await assert.rejects(
      () => callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: fakeFetch,
      }),
      /500/,
    );
  });

  it('throws GeminiRateLimitError on 429 with parsed retry delay', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'quota exceeded',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
        ],
      },
    });
    const fakeFetch = async () => new Response(body, { status: 429 });
    try {
      await callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: fakeFetch,
      });
      assert.fail('expected throw');
    } catch (err: any) {
      assert.equal(err.name, 'GeminiRateLimitError');
      assert.equal(err.retryAfterSeconds, 42);
      assert.ok(err instanceof GeminiRateLimitError);
    }
  });

  it('falls back to 60s retry when 429 has no RetryInfo', async () => {
    const fakeFetch = async () => new Response('{"error":{"code":429}}', { status: 429 });
    try {
      await callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: fakeFetch,
      });
      assert.fail('expected throw');
    } catch (err: any) {
      assert.equal(err.name, 'GeminiRateLimitError');
      assert.equal(err.retryAfterSeconds, 60);
    }
  });

  it('throws on empty candidates', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    await assert.rejects(
      () => callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: fakeFetch,
      }),
      /empty response/,
    );
  });

  it('propagates API error messages', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({
      error: { message: 'Quota exceeded' },
    }), { status: 200 });
    await assert.rejects(
      () => callGemini(makeCtx(), SAMPLE_FINDINGS, {
        apiKey: 'k', model: 'm', timeoutMs: 5000, fetchImpl: fakeFetch,
      }),
      /Quota exceeded/,
    );
  });
});

describe('ai-diagnose: queries', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null when no diagnosis exists', () => {
    assert.equal(getLatestDiagnosis(db, 'h1', 'nginx'), null);
  });

  it('inserts and retrieves latest diagnosis', () => {
    const call = {
      diagnosis: {
        rootCause: 'rc', reasoning: 're', suggestedFix: 'fx',
        confidence: 0.7, caveats: ['c1', 'c2'],
      },
      model: 'gemini-2.0-flash',
      promptTokens: 10, responseTokens: 20, latencyMs: 1500,
    };
    const row = insertDiagnosis(db, 'h1', 'nginx', 'hash-abc', call);
    assert.equal(row.root_cause, 'rc');
    assert.equal(row.context_hash, 'hash-abc');

    const latest = getLatestDiagnosis(db, 'h1', 'nginx');
    assert.equal(latest.id, row.id);

    const json = rowToJson(latest);
    assert.equal(json.rootCause, 'rc');
    assert.deepEqual(json.caveats, ['c1', 'c2']);
    assert.equal(json.confidence, 0.7);
  });

  it('returns the newest row when multiple exist', () => {
    const mk = (rc: string, hash: string) => ({
      diagnosis: { rootCause: rc, reasoning: 'r', suggestedFix: 's', confidence: 0.5, caveats: [] },
      model: 'm', promptTokens: null, responseTokens: null, latencyMs: 100,
    });
    insertDiagnosis(db, 'h1', 'nginx', 'h1', mk('old', 'h1'));
    // small delay to ensure different created_at would not matter because id desc also wins
    insertDiagnosis(db, 'h1', 'nginx', 'h2', mk('new', 'h2'));
    const latest = getLatestDiagnosis(db, 'h1', 'nginx');
    assert.equal(latest.root_cause, 'new');
  });
});
