import type Database from 'better-sqlite3';
const { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS } = require('./severity');

type Severity = 'critical' | 'warning' | 'info';

interface AlertRule {
  alert_type: string;
  severity: Severity;
  enabled: number;   // 0 | 1
  mail: number;      // 0 | 1
  webhook: number;   // 0 | 1
}

interface AlertRuleWithDesc extends AlertRule {
  description: string;
}

function syntheticDefault(type: string): AlertRule {
  const severity: Severity = DEFAULT_SEVERITY[type] ?? 'warning';
  return {
    alert_type: type,
    severity,
    enabled: 1,
    mail: severity === 'critical' ? 1 : 0,
    webhook: 1,
  };
}

function getRule(db: Database.Database, type: string): AlertRule {
  const row = db.prepare(
    'SELECT alert_type, severity, enabled, mail, webhook FROM alert_rules WHERE alert_type = ?'
  ).get(type) as AlertRule | undefined;
  return row ?? syntheticDefault(type);
}

function getAllRules(db: Database.Database): AlertRuleWithDesc[] {
  const rows = db.prepare(
    'SELECT alert_type, severity, enabled, mail, webhook FROM alert_rules ORDER BY alert_type'
  ).all() as AlertRule[];
  return rows.map(r => ({ ...r, description: ALERT_DESCRIPTIONS[r.alert_type] ?? '' }));
}

const VALID_SEVERITY: ReadonlySet<string> = new Set(['critical', 'warning', 'info']);

function updateRule(db: Database.Database, type: string, patch: Partial<Omit<AlertRule, 'alert_type'>>): void {
  if (patch.severity !== undefined && !VALID_SEVERITY.has(patch.severity)) {
    throw new Error(`invalid severity: ${patch.severity}`);
  }
  const current = getRule(db, type);
  const next: AlertRule = {
    alert_type: type,
    severity: patch.severity ?? current.severity,
    enabled:  patch.enabled  ?? current.enabled,
    mail:     patch.mail     ?? current.mail,
    webhook:  patch.webhook  ?? current.webhook,
  };
  db.prepare(`
    INSERT INTO alert_rules (alert_type, severity, enabled, mail, webhook)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(alert_type) DO UPDATE SET
      severity = excluded.severity,
      enabled  = excluded.enabled,
      mail     = excluded.mail,
      webhook  = excluded.webhook
  `).run(next.alert_type, next.severity, next.enabled, next.mail, next.webhook);
}

function resetRules(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM alert_rules').run();
    ensureRulesSeeded(db);
  });
  tx();
}

function ensureRulesSeeded(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO alert_rules (alert_type, severity, enabled, mail, webhook)
    VALUES (?, ?, 1, ?, 1)
  `);
  const tx = db.transaction(() => {
    for (const [type, severity] of Object.entries(DEFAULT_SEVERITY) as [string, Severity][]) {
      insert.run(type, severity, severity === 'critical' ? 1 : 0);
    }
  });
  tx();
}

module.exports = { getRule, getAllRules, updateRule, resetRules, ensureRulesSeeded };
