import type Database from 'better-sqlite3';
import type { AIDiagnoseCall } from './service';

export interface AIDiagnosisRow {
  id: number;
  host_id: string;
  container_name: string;
  context_hash: string;
  model: string;
  root_cause: string;
  reasoning: string;
  suggested_fix: string;
  confidence: number | null;
  caveats: string | null;
  prompt_tokens: number | null;
  response_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export function getLatestDiagnosis(
  db: Database.Database,
  hostId: string,
  containerName: string,
): AIDiagnosisRow | null {
  const row = db.prepare(
    `SELECT id, host_id, container_name, context_hash, model, root_cause, reasoning,
            suggested_fix, confidence, caveats, prompt_tokens, response_tokens, latency_ms, created_at
       FROM ai_diagnoses
      WHERE host_id = ? AND container_name = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
  ).get(hostId, containerName) as AIDiagnosisRow | undefined;
  return row ?? null;
}

export function insertDiagnosis(
  db: Database.Database,
  hostId: string,
  containerName: string,
  contextHash: string,
  call: AIDiagnoseCall,
): AIDiagnosisRow {
  const caveatsJson = JSON.stringify(call.diagnosis.caveats);
  const result = db.prepare(
    `INSERT INTO ai_diagnoses
       (host_id, container_name, context_hash, model, root_cause, reasoning,
        suggested_fix, confidence, caveats, prompt_tokens, response_tokens, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hostId,
    containerName,
    contextHash,
    call.model,
    call.diagnosis.rootCause,
    call.diagnosis.reasoning,
    call.diagnosis.suggestedFix,
    call.diagnosis.confidence,
    caveatsJson,
    call.promptTokens,
    call.responseTokens,
    call.latencyMs,
  );
  const row = db.prepare('SELECT * FROM ai_diagnoses WHERE id = ?').get(result.lastInsertRowid) as AIDiagnosisRow;
  return row;
}

export function rowToJson(row: AIDiagnosisRow): Record<string, unknown> {
  let caveats: string[] = [];
  if (row.caveats) {
    try {
      const parsed = JSON.parse(row.caveats) as unknown;
      if (Array.isArray(parsed)) caveats = parsed.filter((c): c is string => typeof c === 'string');
    } catch { /* ignore */ }
  }
  return {
    id: row.id,
    hostId: row.host_id,
    containerName: row.container_name,
    model: row.model,
    rootCause: row.root_cause,
    reasoning: row.reasoning,
    suggestedFix: row.suggested_fix,
    confidence: row.confidence,
    caveats,
    promptTokens: row.prompt_tokens,
    responseTokens: row.response_tokens,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

module.exports = { getLatestDiagnosis, insertDiagnosis, rowToJson };
