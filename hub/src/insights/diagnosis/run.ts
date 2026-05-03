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
const { diagnoseUnified } = require('./diagnosers/unified') as {
  diagnoseUnified: (ctx: any, options?: { db?: Database.Database; correlationEnabled?: boolean }) => Finding[];
};
const { stickyFindings } = require('./sticky') as {
  stickyFindings: (hostId: string, containerName: string, fresh: Finding[]) => Finding[];
};
const { calibrateFindings } = require('./calibration') as {
  calibrateFindings: (db: Database.Database, findings: Finding[]) => Finding[];
};

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

  const raw: Finding[] = diagnoseUnified(ctx, { db });

  // Run through the sticky layer first so evidence + diagnosedAt stay stable
  // across re-runs when the conclusion hasn't actually changed.
  const stable = stickyFindings(entity.hostId, entity.containerName, raw);

  // Calibrate confidence AFTER the sticky layer — confidence is the one
  // field that should update as users vote, even when the conclusion and
  // evidence are frozen. Running calibrateFindings first and then sticky
  // would cache-freeze the calibrated confidence and new votes wouldn't
  // surface until the conclusion itself changed.
  const findings = calibrateFindings(db, stable);

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
    // Evidence is persisted as JSON. Two on-disk shapes are tolerated by the
    // UI parser:
    //   1. Legacy: `string[]` — what the diagnoser used to emit.
    //   2. Rich:   `{ lines: string[], log_bursts: LogBurstRef[] }` — emitted
    //      whenever the finding has structured log-burst evidence so the
    //      InsightsPage can render a "Co-occurring logs" subsection.
    // The rich shape is only used when there's something to put in it; an
    // unchanged finding without bursts still serialises as a plain array
    // for forwards-compat with any external consumer of the column.
    const evidenceJson = (finding.logBursts && finding.logBursts.length > 0)
      ? JSON.stringify({ lines: finding.evidence, log_bursts: finding.logBursts })
      : JSON.stringify(finding.evidence);

    insert.run(
      'container',
      entityId,
      category,
      finding.severity,
      finding.conclusion,
      // message: keep a condensed version for backward compat with old UI
      finding.suggestedAction,
      null, null, null,
      evidenceJson,
      finding.suggestedAction,
      finding.confidence,
    );
  }
}

module.exports = { runDiagnosis };
