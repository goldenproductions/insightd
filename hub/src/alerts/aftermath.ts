import type Database from 'better-sqlite3';

interface ParentRow {
  id: number;
  alert_type: string;
  host_id: string;
  target: string;
  triggered_at: string;
}

interface ChildSummary {
  alert_type: string;
  host_id: string;
  target: string;
  resolved: boolean;
}

interface AftermathSummary {
  parent: ParentRow;
  durationMinutes: number;
  stillFiring: ChildSummary[];
  cleared: ChildSummary[];
}

function buildAftermath(db: Database.Database, parent: ParentRow): AftermathSummary {
  const all = db.prepare(`
    SELECT alert_type, host_id, target, resolved_at FROM alert_state
    WHERE suppressed_by_state_id = ?
  `).all(parent.id) as Array<{ alert_type: string; host_id: string; target: string; resolved_at: string | null }>;
  const cleared: ChildSummary[] = [];
  const stillFiring: ChildSummary[] = [];
  for (const row of all) {
    const entry: ChildSummary = { alert_type: row.alert_type, host_id: row.host_id, target: row.target, resolved: !!row.resolved_at };
    (entry.resolved ? cleared : stillFiring).push(entry);
  }
  const dur = (db.prepare("SELECT (julianday('now') - julianday(?)) * 1440 AS m").get(parent.triggered_at) as { m: number }).m;
  return { parent, durationMinutes: Math.round(dur), stillFiring, cleared };
}

module.exports = { buildAftermath };
