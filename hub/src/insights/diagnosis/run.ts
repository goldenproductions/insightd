/**
 * Diagnosis orchestrator.
 *
 * Composes the context builder, log cache, and diagnosers into a single
 * entry point used by both the container detail handler (on-demand) and
 * the hourly insights generator (persistence).
 */

import type Database from 'better-sqlite3';
import type { DiagnosisEntity, Finding } from './types';

const { buildContext } = require('./context') as {
  buildContext: (db: Database.Database, entity: DiagnosisEntity, logs: any) => any;
};
const { getCachedLogs } = require('./logCache') as {
  getCachedLogs: (hostId: string, containerName: string) => any;
};
const { diagnoseUnhealthy } = require('./diagnosers/unhealthy') as {
  diagnoseUnhealthy: (ctx: any) => Finding[];
};

const DIAGNOSERS = [diagnoseUnhealthy];

export interface RunDiagnosisOptions {
  /** If set, persist findings to the insights table under this category. */
  persistCategory?: string;
}

/**
 * Run all diagnosers against an entity, returning structured findings.
 * Optionally persist findings to the insights table.
 */
export function runDiagnosis(
  db: Database.Database,
  entity: DiagnosisEntity,
  options: RunDiagnosisOptions = {},
): Finding[] {
  const logs = getCachedLogs(entity.hostId, entity.containerName);

  let ctx;
  try {
    ctx = buildContext(db, entity, logs);
  } catch {
    return []; // no snapshots yet, nothing to diagnose
  }

  const findings: Finding[] = [];
  for (const diagnoser of DIAGNOSERS) {
    findings.push(...diagnoser(ctx));
  }

  if (options.persistCategory && findings.length > 0) {
    persistFindings(db, entity, options.persistCategory, findings);
  }

  return findings;
}

function persistFindings(
  db: Database.Database,
  entity: DiagnosisEntity,
  category: string,
  findings: Finding[],
): void {
  const entityId = `${entity.hostId}/${entity.containerName}`;
  // Clear existing findings for this entity in this category before writing new ones
  db.prepare(
    'DELETE FROM insights WHERE entity_type = ? AND entity_id = ? AND category = ?'
  ).run('container', entityId, category);

  const insert = db.prepare(`
    INSERT INTO insights (
      entity_type, entity_id, category, severity, title, message,
      metric, current_value, baseline_value, evidence, suggested_action, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const finding of findings) {
    insert.run(
      'container',
      entityId,
      category,
      finding.severity,
      finding.conclusion,
      // message: keep a condensed version for backward compat with old UI
      finding.suggestedAction,
      null, null, null,
      JSON.stringify(finding.evidence),
      finding.suggestedAction,
      finding.confidence,
    );
  }
}

module.exports = { runDiagnosis };
