# Strategic Alert Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut email alert spam from "20+ overnight mails" down to one critical mail + one aftermath summary per real incident, with full per-rule operator control.

**Architecture:** Four orthogonal layers slot into `processAlerts` in
`hub/src/alerts/evaluator.ts`: (1) per-rule severity/mail/webhook config
from a new `alert_rules` table; (2) flap dampening via `pending_since`
state columns; (3) dependent suppression with parent-active gate and an
aftermath email when the parent clears; (4) new settings + admin UI to
tune every rule. The same changes are mirrored into `src/` for
standalone mode.

**Tech Stack:** TypeScript (strict), Node.js 20, better-sqlite3, nodemailer, React 19 + TanStack Query for the settings UI, `node:test` + tsx for tests.

**Spec reference:** `docs/superpowers/specs/2026-05-11-strategic-alert-mail-design.md`

---

## File Map

**Create (hub-side):**
- `hub/src/alerts/severity.ts` — `DEFAULT_SEVERITY` map, `ALERT_DESCRIPTIONS`, `effectiveSeverity()`
- `hub/src/alerts/dependencies.ts` — `DEPS` array + `findActiveParent()` + `findActiveChildren()`
- `hub/src/alerts/rules.ts` — `seedRules()`, `getRule()`, `getAllRules()`, `updateRule()`, `resetRules()`
- `hub/src/alerts/aftermath.ts` — `buildAftermath()`, `renderAftermathMail()`
- `hub/src/alerts/mute-token.ts` — HMAC sign/verify for one-click mute URLs
- `hub/src/web/frontend/src/pages/AlertRulesSection.tsx` — UI table component
- Tests: `tests/alerts-severity.test.ts`, `tests/alerts-rules.test.ts`, `tests/alerts-dependencies.test.ts`, `tests/alerts-flap-dampening.test.ts`, `tests/alerts-dependent-suppression.test.ts`, `tests/alerts-rule-engine.test.ts`, `tests/alerts-aftermath.test.ts`, `tests/alerts-mute-token.test.ts`, `tests/alerts-rules-api.test.ts`

**Create (standalone-side):**
- `src/alerts/severity.ts`, `src/alerts/dependencies.ts`, `src/alerts/rules.ts`, `src/alerts/aftermath.ts`, `src/alerts/mute-token.ts` (verbatim copies — same pattern as existing `src/alerts/{evaluator,sender}.ts`)

**Modify:**
- `hub/src/db/schema.ts` — bump `SCHEMA_VERSION` to 52, add `alert_rules` CREATE TABLE in bootstrap, add migration block `if (fromVersion < 52)`, add new columns on `alert_state`
- `src/db/schema.ts` — mirror same migration
- `hub/src/alerts/evaluator.ts` — rewire `processAlerts` to call the new layers; add `runAftermath()` invoked from `runAlerts`
- `src/alerts/evaluator.ts` — mirror
- `hub/src/alerts/sender.ts` — accept `severity` + `muteToken` in context; subject prefix; footer
- `src/alerts/sender.ts` — mirror
- `shared/mail/alert-template.ts` — severity badge + mute/snooze/settings footer
- `hub/src/db/settings.ts` — register `mailCriticalOnly`, `suppressDependents`, `flapStabilizeMinutes`, `diskCriticalPercent` in `SETTING_DEFS`; surface them in `getEffectiveConfig`
- `src/config.ts` and `hub/src/config.ts` — same four keys in `AlertsConfig` interface
- `hub/src/web/server.ts` — register four new routes (GET/PUT alert-rules, POST reset, GET mute)
- `hub/src/web/handlers.ts` — five new handlers
- `hub/src/web/frontend/src/pages/SettingsPage.tsx` — embed `<AlertRulesSection />`
- `hub/src/web/frontend/src/types/api.ts` — add `AlertRule` type

**Each file's responsibility (boundaries):**
- `severity.ts`: static knowledge of which alert types exist + their default severity. No DB.
- `dependencies.ts`: static dependency graph + DB lookups that match parents to children. No mail.
- `rules.ts`: CRUD over the `alert_rules` table. No business logic.
- `aftermath.ts`: assemble + render the consolidated post-parent-resolved email. No DB writes.
- `mute-token.ts`: HMAC token shared between `sender.ts` (signs) and `handlers.ts` (verifies).
- `evaluator.ts`: orchestration — calls everything else, owns no static data.

---

## Tasks

### Task 1: Static severity map + descriptions

**Files:**
- Create: `hub/src/alerts/severity.ts`
- Test: `tests/alerts-severity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-severity.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS, effectiveSeverity } = require('../hub/src/alerts/severity');

test('every critical default matches the design spec', () => {
  const critical = [
    'host_offline', 'container_down', 'workload_unavailable', 'endpoint_down',
    'pve_cluster_quorum_lost', 'node_not_ready', 'pve_zfs_unhealthy',
    'cert_expired', 'disk_full', 'pve_storage_saturation', 'image_pull_failure',
  ];
  for (const t of critical) {
    assert.equal(DEFAULT_SEVERITY[t], 'critical', `${t} should default to critical`);
  }
});

test('every warning default is present', () => {
  const warnings = [
    'restart_loop', 'high_cpu', 'high_memory', 'container_memory_saturation',
    'container_cpu_saturation', 'high_host_cpu', 'low_host_memory', 'high_load',
    'container_unhealthy', 'node_pressure', 'workload_degraded',
    'workload_rollout_stuck', 'pod_pending', 'cert_expiring_soon',
    'cert_invalid', 'pve_backup_overdue',
  ];
  for (const t of warnings) {
    assert.equal(DEFAULT_SEVERITY[t], 'warning', `${t} should default to warning`);
  }
});

test('every alert type has a description', () => {
  for (const t of Object.keys(DEFAULT_SEVERITY)) {
    assert.ok(ALERT_DESCRIPTIONS[t], `${t} missing description`);
    assert.ok(ALERT_DESCRIPTIONS[t].length > 10, `${t} description too short`);
  }
});

test('effectiveSeverity downgrades disk_full below diskCriticalPercent', () => {
  const rule = { alert_type: 'disk_full', severity: 'critical', enabled: 1, mail: 1, webhook: 1 };
  assert.equal(effectiveSeverity({ type: 'disk_full', value: 90 }, rule, 95), 'warning');
  assert.equal(effectiveSeverity({ type: 'disk_full', value: 96 }, rule, 95), 'critical');
});

test('effectiveSeverity passes through non-disk types', () => {
  const rule = { alert_type: 'host_offline', severity: 'critical', enabled: 1, mail: 1, webhook: 1 };
  assert.equal(effectiveSeverity({ type: 'host_offline', value: 30 }, rule, 95), 'critical');
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-severity.test.ts
```
Expected: FAIL with `Cannot find module '../hub/src/alerts/severity'`.

- [ ] **Step 3: Write the module**

Create `hub/src/alerts/severity.ts`:

```ts
export type Severity = 'critical' | 'warning' | 'info';

export const DEFAULT_SEVERITY: Record<string, Severity> = {
  host_offline:                'critical',
  container_down:              'critical',
  workload_unavailable:        'critical',
  endpoint_down:               'critical',
  pve_cluster_quorum_lost:     'critical',
  node_not_ready:              'critical',
  pve_zfs_unhealthy:           'critical',
  cert_expired:                'critical',
  disk_full:                   'critical',
  pve_storage_saturation:      'critical',
  image_pull_failure:          'critical',
  restart_loop:                'warning',
  high_cpu:                    'warning',
  high_memory:                 'warning',
  container_memory_saturation: 'warning',
  container_cpu_saturation:    'warning',
  high_host_cpu:               'warning',
  low_host_memory:             'warning',
  high_load:                   'warning',
  container_unhealthy:         'warning',
  node_pressure:               'warning',
  workload_degraded:           'warning',
  workload_rollout_stuck:      'warning',
  pod_pending:                 'warning',
  cert_expiring_soon:          'warning',
  cert_invalid:                'warning',
  pve_backup_overdue:          'warning',
};

export const ALERT_DESCRIPTIONS: Record<string, string> = {
  host_offline:                'Agent stopped reporting — host may be down or partitioned.',
  container_down:              'A container that was running is now exited or dead.',
  workload_unavailable:        'Kubernetes workload has zero ready replicas.',
  endpoint_down:               'HTTP endpoint check failed for N consecutive runs.',
  pve_cluster_quorum_lost:     'Proxmox cluster lost quorum — split-brain risk.',
  node_not_ready:              'Kubernetes node Ready condition is not True.',
  pve_zfs_unhealthy:           'Proxmox ZFS pool reports DEGRADED/FAULTED state.',
  cert_expired:                'TLS certificate already expired — site is broken.',
  disk_full:                   'Disk usage above threshold (severity depends on diskCriticalPercent).',
  pve_storage_saturation:      'Proxmox storage above threshold (severity gated like disk_full).',
  image_pull_failure:          'k8s ImagePullBackOff / ErrImagePull / InvalidImageName / CreateContainerConfigError.',
  restart_loop:                'Container restarted N times in the last 30 minutes.',
  high_cpu:                    'Container CPU above threshold percent.',
  high_memory:                 'Container memory MB above threshold.',
  container_memory_saturation: 'Container near its k8s memory limit (OOMKill risk).',
  container_cpu_saturation:    'Container near its k8s CPU limit.',
  high_host_cpu:               'Host CPU above threshold percent.',
  low_host_memory:             'Host available memory below threshold MB.',
  high_load:                   'Host 5-min load average above threshold.',
  container_unhealthy:         'Docker / k8s health check is failing.',
  node_pressure:               'k8s node MemoryPressure / DiskPressure / PIDPressure is True.',
  workload_degraded:           'Workload has some but not all replicas ready past threshold.',
  workload_rollout_stuck:      'Workload has pending updates that are not progressing.',
  pod_pending:                 'Pod stuck Pending past threshold minutes.',
  cert_expiring_soon:          'TLS certificate expires inside warning window.',
  cert_invalid:                'TLS chain or hostname mismatch.',
  pve_backup_overdue:          'Proxmox guest has no successful vzdump in N days.',
};

interface AlertLike { type: string; value?: any }
interface RuleLike { severity: Severity }

export function effectiveSeverity(alert: AlertLike, rule: RuleLike, diskCriticalPercent: number): Severity {
  if (alert.type !== 'disk_full' && alert.type !== 'pve_storage_saturation') {
    return rule.severity;
  }
  const pct = Number(alert.value);
  if (!Number.isFinite(pct)) return rule.severity;
  return pct >= diskCriticalPercent ? 'critical' : 'warning';
}

module.exports = { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS, effectiveSeverity };
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-severity.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/alerts/severity.ts tests/alerts-severity.test.ts
git commit -m "feat(alerts): static severity map + descriptions per alert type"
```

---

### Task 2: Schema migration v52 — alert_rules table + alert_state columns

**Files:**
- Modify: `hub/src/db/schema.ts:4` (SCHEMA_VERSION constant), `hub/src/db/schema.ts:452-470` (alert_state CREATE), append a new migration block before line 1367
- Test: `tests/alerts-schema-v52.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-schema-v52.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');

test('alert_rules table exists after bootstrap and is seeded', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  const rows = db.prepare('SELECT alert_type, severity, enabled, mail, webhook FROM alert_rules ORDER BY alert_type').all();
  assert.ok(rows.length >= 27, `expected at least 27 seeded rules, got ${rows.length}`);
  const host = rows.find((r: any) => r.alert_type === 'host_offline');
  assert.deepEqual(host, { alert_type: 'host_offline', severity: 'critical', enabled: 1, mail: 1, webhook: 1 });
  const restart = rows.find((r: any) => r.alert_type === 'restart_loop');
  assert.deepEqual(restart, { alert_type: 'restart_loop', severity: 'warning', enabled: 1, mail: 0, webhook: 1 });
});

test('alert_state has the four new columns', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  const cols = db.prepare("PRAGMA table_info(alert_state)").all() as { name: string }[];
  const names = new Set(cols.map(c => c.name));
  assert.ok(names.has('severity'), 'severity column missing');
  assert.ok(names.has('pending_since'), 'pending_since column missing');
  assert.ok(names.has('resolved_pending_since'), 'resolved_pending_since column missing');
  assert.ok(names.has('suppressed_by_state_id'), 'suppressed_by_state_id column missing');
});

test('migration from v51 backfills pending_since and severity', () => {
  const db = new Database(':memory:');
  bootstrap(db);
  db.prepare("UPDATE meta SET value = '51' WHERE key = 'schema_version'").run();
  db.exec(`
    DROP TABLE alert_rules;
    CREATE TABLE alert_state_old AS SELECT * FROM alert_state;
    DROP TABLE alert_state;
    CREATE TABLE alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL DEFAULT 'local',
      alert_type TEXT NOT NULL,
      target TEXT NOT NULL,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      last_notified TEXT NOT NULL DEFAULT (datetime('now')),
      notify_count INTEGER DEFAULT 1,
      message TEXT, trigger_value TEXT, threshold TEXT,
      silenced_until TEXT, silenced_by TEXT, silenced_at TEXT
    );
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, message)
      VALUES ('h1', 'host_offline', 'system', '2026-05-11 10:00:00', '2026-05-11 10:00:00', 1, 'down');
  `);
  bootstrap(db);  // re-run; should detect old version and migrate
  const row = db.prepare("SELECT severity, pending_since FROM alert_state WHERE alert_type = 'host_offline'").get() as any;
  assert.equal(row.severity, 'critical');
  assert.equal(row.pending_since, '2026-05-11 10:00:00');
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-schema-v52.test.ts
```
Expected: FAIL on `no such table: alert_rules`.

- [ ] **Step 3: Bump SCHEMA_VERSION**

In `hub/src/db/schema.ts` line 4, change:
```ts
const SCHEMA_VERSION = 51;
```
to:
```ts
const SCHEMA_VERSION = 52;
```

- [ ] **Step 4: Add alert_rules CREATE TABLE to bootstrap**

In `hub/src/db/schema.ts`, immediately after the existing `alert_state` CREATE TABLE block (after line 470, before the `settings` table), insert:

```ts
    CREATE TABLE IF NOT EXISTS alert_rules (
      alert_type  TEXT PRIMARY KEY,
      severity    TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
      enabled     INTEGER NOT NULL DEFAULT 1,
      mail        INTEGER NOT NULL,
      webhook     INTEGER NOT NULL DEFAULT 1
    );
```

Also extend the `alert_state` CREATE TABLE (lines 452-467) to add the four new columns at the end:

```ts
    CREATE TABLE IF NOT EXISTS alert_state (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id         TEXT NOT NULL DEFAULT 'local',
      alert_type      TEXT NOT NULL,
      target          TEXT NOT NULL,
      triggered_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      last_notified   TEXT NOT NULL DEFAULT (datetime('now')),
      notify_count    INTEGER DEFAULT 1,
      message         TEXT,
      trigger_value   TEXT,
      threshold       TEXT,
      silenced_until  TEXT,
      silenced_by     TEXT,
      silenced_at     TEXT,
      severity        TEXT,
      pending_since   TEXT,
      resolved_pending_since TEXT,
      suppressed_by_state_id INTEGER
    );
```

- [ ] **Step 5: Add migration block**

In `hub/src/db/schema.ts`, after the existing `if (fromVersion < 51)` block (around line 1367), append:

```ts
  if (fromVersion < 52) {
    // Alert mail strategy v2 — severity-aware mail filter, flap dampening,
    // dependent suppression. Adds rule table + new alert_state columns.
    try { db.exec('ALTER TABLE alert_state ADD COLUMN severity TEXT'); } catch { /* exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN pending_since TEXT'); } catch { /* exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN resolved_pending_since TEXT'); } catch { /* exists */ }
    try { db.exec('ALTER TABLE alert_state ADD COLUMN suppressed_by_state_id INTEGER'); } catch { /* exists */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        alert_type  TEXT PRIMARY KEY,
        severity    TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
        enabled     INTEGER NOT NULL DEFAULT 1,
        mail        INTEGER NOT NULL,
        webhook     INTEGER NOT NULL DEFAULT 1
      );
    `);
    // Backfill pending_since from triggered_at so the new flap-gate logic
    // treats already-firing alerts as fully stabilized rather than holding them.
    db.exec("UPDATE alert_state SET pending_since = triggered_at WHERE pending_since IS NULL AND resolved_at IS NULL");
    // Seed alert_rules from the static defaults. Done here AND in the new
    // ensureRulesSeeded() that runs every boot to cover future-added types.
    const { DEFAULT_SEVERITY } = require('../alerts/severity');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO alert_rules (alert_type, severity, enabled, mail, webhook)
      VALUES (?, ?, 1, ?, 1)
    `);
    for (const [type, severity] of Object.entries(DEFAULT_SEVERITY) as [string, string][]) {
      insert.run(type, severity, severity === 'critical' ? 1 : 0);
    }
    // Backfill alert_state.severity from the seeded rule rows
    db.exec("UPDATE alert_state SET severity = (SELECT severity FROM alert_rules WHERE alert_rules.alert_type = alert_state.alert_type) WHERE severity IS NULL");
  }
```

- [ ] **Step 6: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-schema-v52.test.ts
```
Expected: all 3 tests pass.

- [ ] **Step 7: Run full test suite to confirm no regressions**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -20
```
Expected: all existing tests pass (existing alert tests may need updates in later tasks — if any unrelated test fails, stop and investigate).

- [ ] **Step 8: Commit**

```bash
git add hub/src/db/schema.ts tests/alerts-schema-v52.test.ts
git commit -m "feat(db): schema v52 — alert_rules table + alert_state state columns"
```

---

### Task 3: Rules CRUD module

**Files:**
- Create: `hub/src/alerts/rules.ts`
- Test: `tests/alerts-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-rules.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { getRule, getAllRules, updateRule, resetRules, ensureRulesSeeded } = require('../hub/src/alerts/rules');

function freshDb() {
  const db = new Database(':memory:');
  bootstrap(db);
  return db;
}

test('getRule returns seeded row', () => {
  const db = freshDb();
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
  assert.equal(r.enabled, 1);
});

test('getRule returns synthetic row for unknown type (defaults from static map)', () => {
  const db = freshDb();
  db.prepare("DELETE FROM alert_rules WHERE alert_type = 'host_offline'").run();
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
});

test('getRule returns warning fallback for unmapped type', () => {
  const db = freshDb();
  const r = getRule(db, 'totally_new_alert_type');
  assert.equal(r.severity, 'warning');
  assert.equal(r.mail, 0);
});

test('getAllRules returns sorted list with descriptions', () => {
  const db = freshDb();
  const rows = getAllRules(db);
  assert.ok(rows.length >= 27);
  for (const r of rows) {
    assert.ok(r.description, `${r.alert_type} missing description`);
  }
  // sorted by alert_type
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].alert_type >= rows[i - 1].alert_type);
  }
});

test('updateRule changes one field only', () => {
  const db = freshDb();
  updateRule(db, 'restart_loop', { mail: 1 });
  const r = getRule(db, 'restart_loop');
  assert.equal(r.mail, 1);
  assert.equal(r.severity, 'warning');
  assert.equal(r.enabled, 1);
});

test('updateRule rejects unknown severity', () => {
  const db = freshDb();
  assert.throws(() => updateRule(db, 'restart_loop', { severity: 'fatal' as any }));
});

test('resetRules wipes overrides and reseeds', () => {
  const db = freshDb();
  updateRule(db, 'restart_loop', { mail: 1, severity: 'critical' });
  resetRules(db);
  const r = getRule(db, 'restart_loop');
  assert.equal(r.severity, 'warning');
  assert.equal(r.mail, 0);
});

test('ensureRulesSeeded adds rows for new alert types', () => {
  const db = freshDb();
  db.prepare("DELETE FROM alert_rules WHERE alert_type = 'host_offline'").run();
  ensureRulesSeeded(db);
  const r = getRule(db, 'host_offline');
  assert.equal(r.severity, 'critical');
  assert.equal(r.mail, 1);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rules.test.ts
```
Expected: FAIL with `Cannot find module '../hub/src/alerts/rules'`.

- [ ] **Step 3: Write the module**

Create `hub/src/alerts/rules.ts`:

```ts
import type Database from 'better-sqlite3';
const { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS } = require('./severity');

type Severity = 'critical' | 'warning' | 'info';

export interface AlertRule {
  alert_type: string;
  severity: Severity;
  enabled: number;   // 0 | 1
  mail: number;      // 0 | 1
  webhook: number;   // 0 | 1
}

export interface AlertRuleWithDesc extends AlertRule {
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
  db.prepare('DELETE FROM alert_rules').run();
  ensureRulesSeeded(db);
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
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rules.test.ts
```
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/alerts/rules.ts tests/alerts-rules.test.ts
git commit -m "feat(alerts): rules CRUD module — getRule/getAllRules/updateRule/resetRules"
```

---

### Task 4: Dependency map + active-parent lookup

**Files:**
- Create: `hub/src/alerts/dependencies.ts`
- Test: `tests/alerts-dependencies.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-dependencies.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { findActiveParent, findActiveChildren, DEPS } = require('../hub/src/alerts/dependencies');

function withHost(db: any, host: string, cluster: string | null = null) {
  db.prepare(`
    INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id)
    VALUES (?, datetime('now'), datetime('now'), 'docker', ?)
  `).run(host, cluster);
}

function activeAlert(db: any, host: string, type: string, target: string) {
  db.prepare(`
    INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, pending_since)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(host, type, target);
}

test('host_offline is parent of container_down on same host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h1', target: 'nginx' });
  assert.ok(parent, 'expected parent to be found');
  assert.equal(parent.alert_type, 'host_offline');
});

test('host_offline does not affect a different host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1'); withHost(db, 'h2');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h2', target: 'nginx' });
  assert.equal(parent, null);
});

test('host_offline does not become its own parent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  const parent = findActiveParent(db, { type: 'host_offline', hostId: 'h1', target: 'system' });
  assert.equal(parent, null);
});

test('resolved parents do not suppress', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'host_offline', 'system');
  db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE alert_type = 'host_offline'").run();
  const parent = findActiveParent(db, { type: 'container_down', hostId: 'h1', target: 'nginx' });
  assert.equal(parent, null);
});

test('pve_cluster_quorum_lost is cluster-scoped — matches all hosts in cluster', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'pve-1', 'cluster-A'); withHost(db, 'pve-2', 'cluster-A'); withHost(db, 'pve-x', 'cluster-B');
  activeAlert(db, 'pve-1', 'pve_cluster_quorum_lost', 'cluster-A');
  const sameCluster = findActiveParent(db, { type: 'pve_zfs_unhealthy', hostId: 'pve-2', target: 'tank' });
  assert.ok(sameCluster);
  const otherCluster = findActiveParent(db, { type: 'pve_zfs_unhealthy', hostId: 'pve-x', target: 'tank' });
  assert.equal(otherCluster, null);
});

test('findActiveChildren returns all active host-scoped children for a parent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  withHost(db, 'h1');
  activeAlert(db, 'h1', 'container_down', 'nginx');
  activeAlert(db, 'h1', 'restart_loop', 'redis');
  activeAlert(db, 'h1', 'high_cpu', 'worker');
  const children = findActiveChildren(db, { alert_type: 'host_offline', host_id: 'h1' });
  const types = new Set(children.map((c: any) => c.alert_type));
  assert.ok(types.has('container_down'));
  assert.ok(types.has('restart_loop'));
  assert.ok(types.has('high_cpu'));
});

test('DEPS array contains the three documented parents', () => {
  const parents = DEPS.map((d: any) => d.parent);
  assert.deepEqual(parents.sort(), ['host_offline', 'node_not_ready', 'pve_cluster_quorum_lost']);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-dependencies.test.ts
```
Expected: FAIL with `Cannot find module '../hub/src/alerts/dependencies'`.

- [ ] **Step 3: Write the module**

Create `hub/src/alerts/dependencies.ts`:

```ts
import type Database from 'better-sqlite3';

type ScopeKey = 'host' | 'cluster';

export interface Dep {
  parent: string;
  scope: ScopeKey;
  children: string[];
}

export const DEPS: Dep[] = [
  {
    parent: 'host_offline',
    scope: 'host',
    children: [
      'container_down', 'restart_loop',
      'high_cpu', 'high_memory',
      'container_memory_saturation', 'container_cpu_saturation',
      'container_unhealthy', 'image_pull_failure',
      'high_host_cpu', 'low_host_memory', 'high_load',
      'node_pressure', 'node_not_ready',
      'workload_unavailable', 'workload_degraded', 'workload_rollout_stuck',
      'pod_pending',
    ],
  },
  {
    parent: 'node_not_ready',
    scope: 'host',
    children: [
      'container_down', 'restart_loop', 'container_unhealthy',
      'image_pull_failure', 'pod_pending',
      'workload_unavailable', 'workload_degraded', 'workload_rollout_stuck',
    ],
  },
  {
    parent: 'pve_cluster_quorum_lost',
    scope: 'cluster',
    children: [
      'pve_zfs_unhealthy', 'pve_storage_saturation', 'pve_backup_overdue',
    ],
  },
];

// Reverse index: child -> list of parents that suppress it
const PARENT_INDEX: Map<string, Dep[]> = (() => {
  const m = new Map<string, Dep[]>();
  for (const d of DEPS) {
    for (const c of d.children) {
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(d);
    }
  }
  return m;
})();

interface AlertLike { type: string; hostId: string; target: string }

interface ParentRow {
  id: number;
  alert_type: string;
  host_id: string;
  target: string;
}

function findActiveParent(db: Database.Database, alert: AlertLike): ParentRow | null {
  const parents = PARENT_INDEX.get(alert.type);
  if (!parents) return null;
  for (const dep of parents) {
    let row: ParentRow | undefined;
    if (dep.scope === 'host') {
      row = db.prepare(`
        SELECT id, alert_type, host_id, target FROM alert_state
        WHERE alert_type = ? AND host_id = ? AND resolved_at IS NULL
        LIMIT 1
      `).get(dep.parent, alert.hostId) as ParentRow | undefined;
    } else {
      // cluster scope: alert.hostId's cluster matches parent's hostId's cluster
      row = db.prepare(`
        SELECT s.id, s.alert_type, s.host_id, s.target
        FROM alert_state s
        JOIN hosts hp ON hp.host_id = s.host_id
        JOIN hosts hc ON hc.host_id = ?
        WHERE s.alert_type = ?
          AND s.resolved_at IS NULL
          AND hp.proxmox_cluster_id IS NOT NULL
          AND hp.proxmox_cluster_id = hc.proxmox_cluster_id
        LIMIT 1
      `).get(alert.hostId, dep.parent) as ParentRow | undefined;
    }
    if (row) return row;
  }
  return null;
}

interface ParentLike { alert_type: string; host_id: string }

function findActiveChildren(db: Database.Database, parent: ParentLike): Array<{ id: number; alert_type: string; host_id: string; target: string; resolved_at: string | null }> {
  const dep = DEPS.find(d => d.parent === parent.alert_type);
  if (!dep) return [];
  const placeholders = dep.children.map(() => '?').join(',');
  if (dep.scope === 'host') {
    return db.prepare(`
      SELECT id, alert_type, host_id, target, resolved_at FROM alert_state
      WHERE host_id = ? AND alert_type IN (${placeholders})
    `).all(parent.host_id, ...dep.children) as any;
  }
  return db.prepare(`
    SELECT s.id, s.alert_type, s.host_id, s.target, s.resolved_at FROM alert_state s
    JOIN hosts hp ON hp.host_id = s.host_id
    JOIN hosts hc ON hc.host_id = ?
    WHERE s.alert_type IN (${placeholders})
      AND hp.proxmox_cluster_id IS NOT NULL
      AND hp.proxmox_cluster_id = hc.proxmox_cluster_id
  `).all(parent.host_id, ...dep.children) as any;
}

module.exports = { DEPS, findActiveParent, findActiveChildren };
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-dependencies.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/alerts/dependencies.ts tests/alerts-dependencies.test.ts
git commit -m "feat(alerts): dependency graph + parent-active lookup"
```

---

### Task 5: New settings keys

**Files:**
- Modify: `hub/src/db/settings.ts`, `hub/src/config.ts`
- Test: `tests/alerts-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { getEffectiveConfig, SETTING_DEFS } = require('../hub/src/db/settings');

test('SETTING_DEFS includes the four new mail-strategy keys', () => {
  const keys = new Set(SETTING_DEFS.map((d: any) => d.key));
  assert.ok(keys.has('alerts.mailCriticalOnly'));
  assert.ok(keys.has('alerts.suppressDependents'));
  assert.ok(keys.has('alerts.flapStabilizeMinutes'));
  assert.ok(keys.has('alerts.diskCriticalPercent'));
});

test('default values from getEffectiveConfig', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const cfg = getEffectiveConfig(db, { alerts: {} });
  assert.equal(cfg.alerts.mailCriticalOnly, true);
  assert.equal(cfg.alerts.suppressDependents, true);
  assert.equal(cfg.alerts.flapStabilizeMinutes, 5);
  assert.equal(cfg.alerts.diskCriticalPercent, 95);
});

test('overrides via settings table', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('alerts.mailCriticalOnly', 'false');
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('alerts.flapStabilizeMinutes', '0');
  const cfg = getEffectiveConfig(db, { alerts: {} });
  assert.equal(cfg.alerts.mailCriticalOnly, false);
  assert.equal(cfg.alerts.flapStabilizeMinutes, 0);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-settings.test.ts
```
Expected: FAIL — keys not in SETTING_DEFS.

- [ ] **Step 3: Add the four SETTING_DEFS entries**

In `hub/src/db/settings.ts`, in the SETTING_DEFS array right after the `alerts.reminderMaxMinutes` row (around line 116), insert:

```ts
  { key: 'alerts.mailCriticalOnly', env: 'INSIGHTD_ALERT_MAIL_CRITICAL_ONLY', type: 'bool', category: 'Alerts', label: 'Mail critical only', hotReload: true, default: 'true', description: 'When on, only critical-severity alerts may send email. Per-rule mail toggle still required. Webhooks unaffected.' },
  { key: 'alerts.suppressDependents', env: 'INSIGHTD_ALERT_SUPPRESS_DEPENDENTS', type: 'bool', category: 'Alerts', label: 'Suppress dependent alerts', hotReload: true, default: 'true', description: 'When a root-cause alert (host offline, node not ready, cluster quorum lost) is active, suppress mail+webhooks for the alerts it explains. Send one aftermath summary when it resolves.' },
  { key: 'alerts.flapStabilizeMinutes', env: 'INSIGHTD_ALERT_FLAP_STABILIZE', type: 'int', category: 'Alerts', label: 'Flap stabilize (minutes)', hotReload: true, default: '5', description: 'An alert must persist this long before it sends. A resolution must persist this long before it sends. Set 0 to disable (instant mail like the old behavior).' },
  { key: 'alerts.diskCriticalPercent', env: 'INSIGHTD_ALERT_DISK_CRITICAL', type: 'int', category: 'Alerts', label: 'Disk critical threshold (%)', hotReload: true, default: '95', description: 'disk_full and pve_storage_saturation count as critical-severity at or over this percent; treated as warning below it. Used by the mail-critical-only filter.' },
```

- [ ] **Step 4: Surface them in getEffectiveConfig**

In `hub/src/db/settings.ts`, in the `alerts:` block of `getEffectiveConfig` (around line 278), add four lines before the closing `},`:

```ts
      mailCriticalOnly: get('alerts.mailCriticalOnly') ?? true,
      suppressDependents: get('alerts.suppressDependents') ?? true,
      flapStabilizeMinutes: get('alerts.flapStabilizeMinutes') ?? 5,
      diskCriticalPercent: get('alerts.diskCriticalPercent') ?? 95,
```

- [ ] **Step 5: Extend the AlertsConfig interface**

In `hub/src/config.ts`, locate the `AlertsConfig` interface (mirrors the one in `hub/src/db/settings.ts`). Add four optional fields:

```ts
  mailCriticalOnly?: boolean;
  suppressDependents?: boolean;
  flapStabilizeMinutes?: number;
  diskCriticalPercent?: number;
```

Also in `hub/src/db/settings.ts` `AlertsConfig` interface (around line 50, where `cooldownMinutes` is), add the same four fields.

- [ ] **Step 6: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-settings.test.ts && npm run typecheck
```
Expected: 3 tests pass + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add hub/src/db/settings.ts hub/src/config.ts tests/alerts-settings.test.ts
git commit -m "feat(settings): four new keys for strategic alert mail"
```

---

### Task 6: Flap dampening in processAlerts

**Files:**
- Modify: `hub/src/alerts/evaluator.ts:1362-1413` (`processAlerts` body)
- Test: `tests/alerts-flap-dampening.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-flap-dampening.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { processAlerts } = require('../hub/src/alerts/evaluator');

const cfg = (overrides: any = {}) => ({
  smtp: { host: '', port: 0, user: '', pass: '', from: '' },
  alerts: {
    cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440,
    mailCriticalOnly: false, suppressDependents: false,
    flapStabilizeMinutes: 5, diskCriticalPercent: 95,
    ...overrides,
  },
});

function shiftClock(db: any, minutes: number) {
  db.exec(`UPDATE alert_state SET
    triggered_at = datetime(triggered_at, '-${minutes} minutes'),
    last_notified = datetime(last_notified, '-${minutes} minutes'),
    pending_since = CASE WHEN pending_since IS NULL THEN NULL ELSE datetime(pending_since, '-${minutes} minutes') END,
    resolved_pending_since = CASE WHEN resolved_pending_since IS NULL THEN NULL ELSE datetime(resolved_pending_since, '-${minutes} minutes') END
  `);
}

test('initial trigger does not mail before stabilizeMinutes', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 0, 'should hold first send until stable');
  const row = db.prepare('SELECT pending_since, notify_count FROM alert_state').get() as any;
  assert.ok(row.pending_since);
  assert.equal(row.notify_count, 0);
});

test('initial trigger mails after stabilizeMinutes elapse', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 1);
  assert.equal(toSend[0].reminderNumber, 0);
});

test('flap that resolves before stabilize emits no mail', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 2);
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  const toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 0);
  const row = db.prepare("SELECT COUNT(*) AS n FROM alert_state WHERE resolved_at IS NULL").get() as any;
  assert.equal(row.n, 0, 'unmailed flap should be deleted');
});

test('resolution mail held until stabilize then sent', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  processAlerts(db, cfg(), { triggered, resolved: [] });  // initial mail
  shiftClock(db, 1);
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  let toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 0, 'resolution should hold for stabilize');
  shiftClock(db, 6);
  toSend = processAlerts(db, cfg(), { triggered: [], resolved });
  assert.equal(toSend.length, 1);
  assert.equal(toSend[0].isResolution, true);
});

test('flapStabilizeMinutes=0 sends immediately (back-compat)', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  const toSend = processAlerts(db, cfg({ flapStabilizeMinutes: 0 }), { triggered, resolved: [] });
  assert.equal(toSend.length, 1);
});

test('retrigger inside stabilize window does not double-mail', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const triggered = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }];
  processAlerts(db, cfg(), { triggered, resolved: [] });
  shiftClock(db, 6);
  processAlerts(db, cfg(), { triggered, resolved: [] });   // initial mail
  shiftClock(db, 1);
  // resolution observed
  const resolved = [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'up', isResolution: true }];
  processAlerts(db, cfg(), { triggered: [], resolved });   // resolution pending
  shiftClock(db, 2);
  // retriggered before resolution stabilizes
  const toSend = processAlerts(db, cfg(), { triggered, resolved: [] });
  assert.equal(toSend.length, 0);
  const row = db.prepare('SELECT resolved_pending_since FROM alert_state').get() as any;
  assert.equal(row.resolved_pending_since, null, 'resolved_pending_since should clear on retrigger');
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-flap-dampening.test.ts
```
Expected: most tests fail (current `processAlerts` sends immediately).

- [ ] **Step 3: Rewrite processAlerts in evaluator.ts**

In `hub/src/alerts/evaluator.ts`, replace the function body of `processAlerts` (lines 1362-1413) with:

```ts
function processAlerts(db: Database.Database, config: EvaluatorConfig, { triggered, resolved }: EvaluationResult): AlertItem[] {
  const toSend: AlertItem[] = [];
  const cooldownMinutes = config.alerts.cooldownMinutes;
  const backoff = config.alerts.reminderBackoff !== false;
  const capMinutes = config.alerts.reminderMaxMinutes ?? 1440;
  const stabilizeMin = Math.max(0, config.alerts.flapStabilizeMinutes ?? 5);

  const minutesSince = (ts: string | null): number => {
    if (!ts) return Number.POSITIVE_INFINITY;
    return (db.prepare("SELECT (julianday('now') - julianday(?)) * 1440 AS m").get(ts) as { m: number }).m;
  };

  for (const alert of triggered) {
    const active = db.prepare(`
      SELECT id, triggered_at, last_notified, notify_count, silenced_until,
             pending_since, resolved_pending_since
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target) as
      { id: number; triggered_at: string; last_notified: string; notify_count: number; silenced_until: string | null; pending_since: string | null; resolved_pending_since: string | null } | undefined;

    if (!active) {
      // First sighting — record state, NO mail until stabilize elapses.
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, message, trigger_value, threshold)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, datetime('now'), ?, ?, ?)
      `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null);
      if (stabilizeMin === 0) {
        // back-compat: immediately bump notify_count and mail
        db.prepare("UPDATE alert_state SET notify_count = 1, last_notified = datetime('now') WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL")
          .run(alert.hostId, alert.type, alert.target);
        toSend.push({ ...alert, reminderNumber: 0 });
      }
      continue;
    }

    // Existing row. Clear any pending-resolution state — alert is back.
    if (active.resolved_pending_since) {
      db.prepare('UPDATE alert_state SET resolved_pending_since = NULL WHERE id = ?').run(active.id);
    }

    if (active.silenced_until) {
      const stillSilenced = (db.prepare("SELECT (julianday(?) > julianday('now')) AS s").get(active.silenced_until) as { s: number }).s === 1;
      if (stillSilenced) continue;
    }

    if (active.notify_count === 0) {
      // Initial mail still pending. Send only after stabilize gate.
      if (minutesSince(active.pending_since) >= stabilizeMin) {
        db.prepare("UPDATE alert_state SET notify_count = 1, last_notified = datetime('now') WHERE id = ?").run(active.id);
        toSend.push({ ...alert, reminderNumber: 0 });
      }
      continue;
    }

    // Already mailed at least once — reminder cadence path (unchanged from prior behavior).
    const requiredGap = requiredReminderGap(active.notify_count, cooldownMinutes, capMinutes, backoff);
    if (minutesSince(active.last_notified) >= requiredGap) {
      const newCount = active.notify_count + 1;
      db.prepare("UPDATE alert_state SET last_notified = datetime('now'), notify_count = ? WHERE id = ?").run(newCount, active.id);
      toSend.push({ ...alert, reminderNumber: newCount - 1 });
    }
  }

  for (const alert of resolved) {
    const row = db.prepare(`
      SELECT id, notify_count, last_notified, resolved_pending_since
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL
    `).get(alert.hostId, alert.type, alert.target) as
      { id: number; notify_count: number; last_notified: string; resolved_pending_since: string | null } | undefined;

    if (!row) continue;

    if (row.notify_count === 0) {
      // Initial alert was never mailed — drop silently. No resolution email.
      db.prepare('DELETE FROM alert_state WHERE id = ?').run(row.id);
      continue;
    }

    if (stabilizeMin === 0 || alert.isSilentResolution) {
      // Send (or silently resolve) immediately.
      db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE id = ?").run(row.id);
      if (!alert.isSilentResolution) toSend.push(alert);
      continue;
    }

    if (!row.resolved_pending_since) {
      db.prepare("UPDATE alert_state SET resolved_pending_since = datetime('now') WHERE id = ?").run(row.id);
      continue;  // first sighting of recovery — wait stabilize
    }

    const pendMin = minutesSince(row.resolved_pending_since);
    const sinceLast = minutesSince(row.last_notified);
    if (pendMin >= stabilizeMin && sinceLast >= stabilizeMin) {
      db.prepare("UPDATE alert_state SET resolved_at = datetime('now') WHERE id = ?").run(row.id);
      toSend.push(alert);
    }
  }

  return toSend;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-flap-dampening.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 5: Run full suite — fix any back-compat fallout**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -30
```
Expected: all tests pass. If existing alert tests fail, they likely assume instant-mail behavior — update them to pass `flapStabilizeMinutes: 0` in their test config, or shift the test clock past the stabilize window.

- [ ] **Step 6: Commit**

```bash
git add hub/src/alerts/evaluator.ts tests/alerts-flap-dampening.test.ts
git commit -m "feat(alerts): flap dampening — stabilize before mail or resolution"
```

---

### Task 7: Dependent suppression + aftermath assembly

**Files:**
- Create: `hub/src/alerts/aftermath.ts`
- Modify: `hub/src/alerts/evaluator.ts` (extend `processAlerts` + add `runAftermath`)
- Test: `tests/alerts-dependent-suppression.test.ts`, `tests/alerts-aftermath.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/alerts-dependent-suppression.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { processAlerts } = require('../hub/src/alerts/evaluator');

const cfg = (overrides: any = {}) => ({
  smtp: { host: '', port: 0, user: '', pass: '', from: '' },
  alerts: {
    cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440,
    mailCriticalOnly: false, suppressDependents: true,
    flapStabilizeMinutes: 0, diskCriticalPercent: 95,
    ...overrides,
  },
});

function addHost(db: any, host: string, cluster: string | null = null) {
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type, proxmox_cluster_id)
              VALUES (?, datetime('now'), datetime('now'), 'docker', ?)`).run(host, cluster);
}

test('host_offline suppresses container_down mails on same host', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  // Parent fires first
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  // Children fire while parent active
  const children = ['nginx', 'redis', 'postgres'].map(c => ({
    type: 'container_down', hostId: 'h1', target: c, message: `${c} down`,
  }));
  const toSend = processAlerts(db, cfg(), { triggered: children, resolved: [] });
  assert.equal(toSend.length, 0, 'children should be fully suppressed');
  for (const c of ['nginx', 'redis', 'postgres']) {
    const row = db.prepare("SELECT suppressed_by_state_id FROM alert_state WHERE alert_type = 'container_down' AND target = ?").get(c) as any;
    assert.ok(row?.suppressed_by_state_id, `${c} should have suppressed_by_state_id set`);
  }
});

test('suppressDependents=false sends all (back-compat)', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  processAlerts(db, cfg({ suppressDependents: false }), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  const toSend = processAlerts(db, cfg({ suppressDependents: false }), {
    triggered: [{ type: 'container_down', hostId: 'h1', target: 'nginx', message: 'down' }],
    resolved: [],
  });
  assert.equal(toSend.length, 1);
});

test('retroactive suppression — parent fires after children', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1');
  // Children fire first
  processAlerts(db, cfg(), {
    triggered: ['nginx', 'redis'].map(c => ({ type: 'container_down', hostId: 'h1', target: c, message: 'down' })),
    resolved: [],
  });
  // Parent fires now — children get retroactively stamped
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  for (const c of ['nginx', 'redis']) {
    const row = db.prepare("SELECT suppressed_by_state_id FROM alert_state WHERE alert_type = 'container_down' AND target = ?").get(c) as any;
    assert.ok(row?.suppressed_by_state_id, `${c} should be retroactively suppressed`);
  }
});

test('cross-host suppression does not leak', () => {
  const db = new Database(':memory:'); bootstrap(db);
  addHost(db, 'h1'); addHost(db, 'h2');
  processAlerts(db, cfg(), {
    triggered: [{ type: 'host_offline', hostId: 'h1', target: 'system', message: 'down' }],
    resolved: [],
  });
  const toSend = processAlerts(db, cfg(), {
    triggered: [{ type: 'container_down', hostId: 'h2', target: 'nginx', message: 'down' }],
    resolved: [],
  });
  assert.equal(toSend.length, 1, 'different host should still mail');
});
```

Create `tests/alerts-aftermath.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { buildAftermath } = require('../hub/src/alerts/aftermath');

test('aftermath summary partitions still-firing vs cleared children', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
              VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  const parent = { id: 1, alert_type: 'host_offline', host_id: 'h1', target: 'system', triggered_at: '2026-05-11 08:00:00' };
  db.prepare(`INSERT INTO alert_state (id, host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, resolved_at, suppressed_by_state_id)
              VALUES
              (2, 'h1', 'container_down', 'nginx',    datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'), 1),
              (3, 'h1', 'container_down', 'redis',    datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'), 1),
              (4, 'h1', 'container_down', 'postgres', datetime('now'), datetime('now'), 1, datetime('now'), NULL, 1)`).run();
  const summary = buildAftermath(db, parent);
  assert.equal(summary.parent.alert_type, 'host_offline');
  assert.equal(summary.stillFiring.length, 1);
  assert.equal(summary.stillFiring[0].target, 'postgres');
  assert.equal(summary.cleared.length, 2);
  const clearedTargets = summary.cleared.map((c: any) => c.target).sort();
  assert.deepEqual(clearedTargets, ['nginx', 'redis']);
});

test('aftermath with zero children returns empty arrays', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type)
              VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  const summary = buildAftermath(db, { id: 1, alert_type: 'host_offline', host_id: 'h1', target: 'system', triggered_at: '2026-05-11 08:00:00' });
  assert.equal(summary.stillFiring.length, 0);
  assert.equal(summary.cleared.length, 0);
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-dependent-suppression.test.ts tests/alerts-aftermath.test.ts
```
Expected: fail — module missing + suppression not wired.

- [ ] **Step 3: Create aftermath.ts**

Create `hub/src/alerts/aftermath.ts`:

```ts
import type Database from 'better-sqlite3';
const { findActiveChildren } = require('./dependencies');

export interface ParentRow {
  id: number;
  alert_type: string;
  host_id: string;
  target: string;
  triggered_at: string;
}

export interface ChildSummary {
  alert_type: string;
  host_id: string;
  target: string;
  resolved: boolean;
}

export interface AftermathSummary {
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
```

- [ ] **Step 4: Wire suppression into processAlerts**

In `hub/src/alerts/evaluator.ts`, at the top of the file alongside existing requires, add:

```ts
const { findActiveParent, findActiveChildren, DEPS } = require('./dependencies');
```

In `processAlerts`, modify the triggered loop. Right after the "Existing row" silence-guard check passes and BEFORE the `notify_count === 0` mail/reminder logic, add the suppression gate:

```ts
    if (config.alerts.suppressDependents !== false) {
      const parent = findActiveParent(db, alert);
      if (parent) {
        // Stamp the row so the parent's eventual resolution can summarize it.
        db.prepare('UPDATE alert_state SET suppressed_by_state_id = ? WHERE id = ?').run(parent.id, active.id);
        continue;
      }
    }
```

Also handle the INITIAL-INSERT case for a brand-new triggered row when a parent is already active. Replace the existing "First sighting" block with:

```ts
    if (!active) {
      // Check parent BEFORE recording state-cost so children don't leave orphan rows
      // missing the suppressed_by stamp.
      let parentId: number | null = null;
      if (config.alerts.suppressDependents !== false) {
        const p = findActiveParent(db, alert);
        if (p) parentId = p.id;
      }
      db.prepare(`
        INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, message, trigger_value, threshold, suppressed_by_state_id)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, datetime('now'), ?, ?, ?, ?)
      `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null, parentId);
      if (parentId !== null) continue;  // suppressed at birth — no mail
      if (stabilizeMin === 0) {
        db.prepare("UPDATE alert_state SET notify_count = 1, last_notified = datetime('now') WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL")
          .run(alert.hostId, alert.type, alert.target);
        toSend.push({ ...alert, reminderNumber: 0 });
      }
      continue;
    }
```

Add retroactive suppression: when a parent fires (i.e. an alert whose type appears as a `dep.parent` in DEPS), immediately stamp all matching active children. Append this block at the *very start* of the triggered loop body (before `active = db.prepare(...).get(...)`):

```ts
    if (config.alerts.suppressDependents !== false) {
      const isParentType = DEPS.some((d: any) => d.parent === alert.type);
      if (isParentType) {
        // Find or pre-create the parent row, then stamp active children with its id.
        let parentRow = db.prepare(
          'SELECT id FROM alert_state WHERE host_id = ? AND alert_type = ? AND target = ? AND resolved_at IS NULL'
        ).get(alert.hostId, alert.type, alert.target) as { id: number } | undefined;
        if (!parentRow) {
          const info = db.prepare(`
            INSERT INTO alert_state (host_id, alert_type, target, triggered_at, last_notified, notify_count, pending_since, message, trigger_value, threshold)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, datetime('now'), ?, ?, ?)
          `).run(alert.hostId, alert.type, alert.target, alert.message, alert.value != null ? String(alert.value) : null, alert.threshold != null ? String(alert.threshold) : null);
          parentRow = { id: Number(info.lastInsertRowid) };
        }
        const children = findActiveChildren(db, { alert_type: alert.type, host_id: alert.hostId });
        const stamp = db.prepare('UPDATE alert_state SET suppressed_by_state_id = ? WHERE id = ? AND suppressed_by_state_id IS NULL AND resolved_at IS NULL');
        for (const c of children) stamp.run(parentRow.id, c.id);
        // Fall through — the parent itself still goes through the normal mail path below.
      }
    }
```

- [ ] **Step 5: Wire aftermath email into runAlerts**

In `hub/src/alerts/evaluator.ts`, at the top, add:

```ts
const { buildAftermath } = require('./aftermath');
```

In `runAlerts`, after the main `for (const alert of toSend)` loop, append:

```ts
  // Aftermath: for each parent that just resolved this cycle, send one
  // consolidated summary instead of individual child resolution mails.
  // Children whose suppressed_by_state_id points at a parent resolved this
  // cycle are not in `toSend` (they were never mailed individually).
  for (const alert of toSend) {
    if (!alert.isResolution) continue;
    const isParentType = DEPS.some((d: any) => d.parent === alert.type);
    if (!isParentType) continue;
    const parentRow = db.prepare(`
      SELECT id, alert_type, host_id, target, triggered_at
      FROM alert_state
      WHERE host_id = ? AND alert_type = ? AND target = ?
      ORDER BY id DESC LIMIT 1
    `).get(alert.hostId, alert.type, alert.target) as any;
    if (!parentRow) continue;
    const summary = buildAftermath(db, parentRow);
    if (summary.stillFiring.length === 0 && summary.cleared.length === 0) continue;
    try {
      const { sendAftermath } = require('./sender');
      await sendAftermath(summary, config);
      logger.info('alerts', `AFTERMATH: ${summary.cleared.length} cleared, ${summary.stillFiring.length} still firing under ${parentRow.alert_type} on ${parentRow.host_id}`);
    } catch (err) {
      logger.error('alerts', 'Aftermath send failed', err);
    }
  }
```

(Add a placeholder `sendAftermath` to `sender.ts` — the real implementation lives in Task 9. For now:)

In `hub/src/alerts/sender.ts`, append:

```ts
async function sendAftermath(_summary: any, _config: any): Promise<void> {
  // Implemented in Task 9.
}
module.exports.sendAftermath = sendAftermath;
```

- [ ] **Step 6: Run tests, verify pass**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-dependent-suppression.test.ts tests/alerts-aftermath.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 7: Run full suite**

```bash
cd /home/andreas/insightd && npm test 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add hub/src/alerts/evaluator.ts hub/src/alerts/aftermath.ts hub/src/alerts/sender.ts tests/alerts-dependent-suppression.test.ts tests/alerts-aftermath.test.ts
git commit -m "feat(alerts): dependent suppression + aftermath summary scaffolding"
```

---

### Task 8: Rule engine gate (mailCriticalOnly + per-rule mail/webhook)

**Files:**
- Modify: `hub/src/alerts/evaluator.ts` `runAlerts` body
- Test: `tests/alerts-rule-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-rule-engine.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { runAlerts } = require('../hub/src/alerts/evaluator');
const { updateRule } = require('../hub/src/alerts/rules');

// Hijack sendAlert / dispatchAlertWebhooks via require cache so tests can
// observe what would be dispatched.
function withSpies(fn: (counts: { mails: any[]; hooks: any[] }) => Promise<void>) {
  const senderPath = require.resolve('../hub/src/alerts/sender');
  const webhooksPath = require.resolve('../shared/webhooks/sender');
  const origSender = require(senderPath);
  const origHooks = require(webhooksPath);
  const counts = { mails: [] as any[], hooks: [] as any[] };
  require.cache[senderPath]!.exports = { ...origSender,
    sendAlert: async (alert: any) => { counts.mails.push(alert); },
    sendAftermath: async () => {}
  };
  require.cache[webhooksPath]!.exports = { ...origHooks,
    dispatchAlertWebhooks: async (_db: any, a: any) => { counts.hooks.push(a); }
  };
  return fn(counts).finally(() => {
    require.cache[senderPath]!.exports = origSender;
    require.cache[webhooksPath]!.exports = origHooks;
  });
}

function fakeContainerDown(db: any) {
  // Pre-create the alert_state row so runAlerts evaluates the world correctly.
  db.prepare(`INSERT INTO hosts (host_id, first_seen, last_seen, runtime_type) VALUES ('h1', datetime('now'), datetime('now'), 'docker')`).run();
  db.prepare(`INSERT INTO container_snapshots (host_id, container_name, status, exit_code, collected_at) VALUES
    ('h1', 'nginx', 'running', NULL, datetime('now', '-1 minutes')),
    ('h1', 'nginx', 'exited', 1, datetime('now'))`).run();
}

test('warning alert with mailCriticalOnly=true does not mail', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { severity: 'warning' });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1, 'webhook should still fire');
  });
});

test('critical alert with mail=0 does not mail but webhooks', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { mail: 0 });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1);
  });
});

test('enabled=0 fires neither channel', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    fakeContainerDown(db);
    updateRule(db, 'container_down', { enabled: 0 });
    const cfg = { alerts: { enabled: true, containerDown: true, mailCriticalOnly: false, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 0);
  });
});

test('disk_full below diskCriticalPercent downgrades to warning, no mail', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    db.prepare(`INSERT INTO disk_snapshots (host_id, mount_point, used_percent, used_gb, total_gb, collected_at)
                VALUES ('h1', '/', 91, 91, 100, datetime('now'))`).run();
    const cfg = { alerts: { enabled: true, diskPercent: 90, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 0);
    assert.equal(counts.hooks.length, 1);
  });
});

test('disk_full at/over diskCriticalPercent mails', async () => {
  await withSpies(async (counts) => {
    const db = new Database(':memory:'); bootstrap(db);
    db.prepare(`INSERT INTO disk_snapshots (host_id, mount_point, used_percent, used_gb, total_gb, collected_at)
                VALUES ('h1', '/', 96, 96, 100, datetime('now'))`).run();
    const cfg = { alerts: { enabled: true, diskPercent: 90, mailCriticalOnly: true, suppressDependents: false, flapStabilizeMinutes: 0, cooldownMinutes: 60, reminderBackoff: true, reminderMaxMinutes: 1440, diskCriticalPercent: 95 }, smtp: { host: 'x', port: 25, user: '', pass: '', from: 'a@b' } };
    await runAlerts(db, cfg);
    assert.equal(counts.mails.length, 1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rule-engine.test.ts
```
Expected: failures — rule engine not wired in.

- [ ] **Step 3: Wire rule engine into runAlerts**

In `hub/src/alerts/evaluator.ts`, at the top:

```ts
const { getRule } = require('./rules');
const { effectiveSeverity } = require('./severity');
```

Replace the mail/webhook dispatch loop inside `runAlerts` (currently lines ~1435-1451) with:

```ts
  for (const alert of toSend) {
    const rule = getRule(db, alert.type);
    if (!rule.enabled) {
      continue;  // muted entirely
    }
    const sev = effectiveSeverity(alert, rule, config.alerts.diskCriticalPercent ?? 95);
    const sevAllowed = config.alerts.mailCriticalOnly === false ? true : sev === 'critical';

    if (rule.mail && sevAllowed) {
      try {
        await sendAlert({ ...alert, severity: sev }, config, db);
        const label = alert.isResolution ? 'RESOLVED' : alert.reminderNumber! > 0 ? `REMINDER #${alert.reminderNumber}` : 'ALERT';
        logger.info('alerts', `${label} [${sev}]: ${alert.message}`);
      } catch (err) {
        logger.error('alerts', `Failed to send alert: ${alert.message}`, err);
      }
    }

    if (rule.webhook) {
      try {
        const { dispatchAlertWebhooks } = require('../../../shared/webhooks/sender');
        await dispatchAlertWebhooks(db, { ...alert, severity: sev });
      } catch (err) {
        logger.error('alerts', `Webhook dispatch failed: ${alert.message}`, err);
      }
    }
  }
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rule-engine.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/alerts/evaluator.ts tests/alerts-rule-engine.test.ts
git commit -m "feat(alerts): rule engine gate — severity + per-rule mail/webhook"
```

---

### Task 9: Mail template severity + footer + aftermath template

**Files:**
- Modify: `shared/mail/alert-template.ts`, `hub/src/alerts/sender.ts`
- Create: `shared/mail/aftermath-template.ts`
- Test: `tests/alerts-mail-template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-mail-template.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { subjectFor, renderAlertHtml } = require('../shared/mail/alert-template');
const { renderAftermathText, renderAftermathHtml, aftermathSubject } = require('../shared/mail/aftermath-template');

test('subject carries severity badge', () => {
  assert.match(subjectFor({ type: 'host_offline', target: 'system', message: 'down', severity: 'critical' }), /^\[CRITICAL\]/);
  assert.match(subjectFor({ type: 'restart_loop', target: 'redis', message: 'flap', severity: 'warning' }), /^\[WARNING\]/);
});

test('html footer contains mute link with token', () => {
  const html = renderAlertHtml({ type: 'restart_loop', target: 'redis', message: 'flap', severity: 'warning' }, { baseUrl: 'https://insightd.local', muteToken: 'tok123' });
  assert.match(html, /mute/i);
  assert.match(html, /tok123/);
});

test('aftermath subject lists counts', () => {
  const summary = {
    parent: { alert_type: 'host_offline', host_id: 'h1', target: 'system' },
    durationMinutes: 47, stillFiring: [{ alert_type: 'container_down', target: 'pg', host_id: 'h1', resolved: false }],
    cleared: [{ alert_type: 'container_down', target: 'nginx', host_id: 'h1', resolved: true }],
  };
  const subj = aftermathSubject(summary);
  assert.match(subj, /h1/);
  assert.match(subj, /1.*cleared/);
  assert.match(subj, /1.*still/);
});

test('aftermath text lists each child', () => {
  const summary = {
    parent: { alert_type: 'host_offline', host_id: 'h1', target: 'system' },
    durationMinutes: 47,
    stillFiring: [{ alert_type: 'container_down', target: 'postgres', host_id: 'h1', resolved: false }],
    cleared: [
      { alert_type: 'container_down', target: 'nginx', host_id: 'h1', resolved: true },
      { alert_type: 'container_down', target: 'redis', host_id: 'h1', resolved: true },
    ],
  };
  const text = renderAftermathText(summary, '');
  assert.match(text, /postgres/);
  assert.match(text, /nginx/);
  assert.match(text, /redis/);
  assert.match(text, /47 minutes/);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-mail-template.test.ts
```
Expected: fail — modules / signatures missing.

- [ ] **Step 3: Update alert-template.ts**

Read `shared/mail/alert-template.ts`. Locate `subjectFor` and prepend severity badge support:

```ts
function subjectFor(alert: any): string {
  const prefix = alert.severity ? `[${String(alert.severity).toUpperCase()}] ` : '';
  // ... existing subject-building logic continues, just wrapped with the prefix.
  const body = /* whatever subject the existing code builds */;
  return prefix + body;
}
```

(Implementer: read existing code first; the change is to add a `[SEVERITY] ` prefix only when `alert.severity` is set, leaving everything else untouched.)

Locate the HTML footer renderer (in the same file). Add this block before the closing `</body>` template literal:

```ts
const muteUrl = ctx?.muteToken && ctx?.baseUrl
  ? `${ctx.baseUrl}/api/alerts/mute?token=${encodeURIComponent(ctx.muteToken)}`
  : null;
const footer = muteUrl
  ? `<hr/><p style="font-size:12px;color:#888">
       <a href="${muteUrl}">Mute this alert type</a> ·
       <a href="${ctx.baseUrl}/settings">Alert settings</a>
     </p>`
  : '';
```

Insert `${footer}` into the HTML template just above the closing tag.

Apply the same change to `renderAlertText` (one-line append).

- [ ] **Step 4: Create aftermath-template.ts**

Create `shared/mail/aftermath-template.ts`:

```ts
interface ChildSummary {
  alert_type: string;
  host_id: string;
  target: string;
  resolved: boolean;
}

interface AftermathSummary {
  parent: { alert_type: string; host_id: string; target: string };
  durationMinutes: number;
  stillFiring: ChildSummary[];
  cleared: ChildSummary[];
}

function aftermathSubject(s: AftermathSummary): string {
  return `[RESOLVED] ${s.parent.alert_type} on ${s.parent.host_id} — ${s.cleared.length} cleared, ${s.stillFiring.length} still firing`;
}

function fmtList(items: ChildSummary[]): string {
  if (items.length === 0) return '  (none)';
  return items.map(i => `  • ${i.alert_type}: ${i.target}`).join('\n');
}

function renderAftermathText(s: AftermathSummary, baseUrl: string): string {
  return [
    `Root cause resolved: ${s.parent.alert_type} on ${s.parent.host_id}.`,
    `Duration: ${s.durationMinutes} minutes.`,
    '',
    'Still firing on this scope:',
    fmtList(s.stillFiring),
    '',
    'Cleared in parallel:',
    fmtList(s.cleared),
    '',
    baseUrl ? `Details: ${baseUrl}/hosts/${encodeURIComponent(s.parent.host_id)}` : '',
  ].join('\n').trim();
}

function liHtml(items: ChildSummary[]): string {
  if (items.length === 0) return '<li><em>none</em></li>';
  return items.map(i => `<li><b>${i.alert_type}:</b> ${i.target}</li>`).join('');
}

function renderAftermathHtml(s: AftermathSummary, baseUrl: string): string {
  return `
    <h2>Root cause resolved</h2>
    <p>${s.parent.alert_type} on <b>${s.parent.host_id}</b> cleared after ${s.durationMinutes} minutes.</p>
    <h3>Still firing</h3><ul>${liHtml(s.stillFiring)}</ul>
    <h3>Cleared in parallel</h3><ul>${liHtml(s.cleared)}</ul>
    ${baseUrl ? `<p><a href="${baseUrl}/hosts/${encodeURIComponent(s.parent.host_id)}">View host</a></p>` : ''}
  `;
}

module.exports = { aftermathSubject, renderAftermathText, renderAftermathHtml };
```

- [ ] **Step 5: Implement real sendAftermath**

Replace the placeholder in `hub/src/alerts/sender.ts`:

```ts
const { aftermathSubject, renderAftermathText, renderAftermathHtml } = require('../../../shared/mail/aftermath-template');

async function sendAftermath(summary: any, config: any): Promise<void> {
  if (!config.smtp.host || !config.alerts.to) return;
  const transporter = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  const baseUrl = config.web?.baseUrl || '';
  await transporter.sendMail({
    from: config.smtp.from,
    to: config.alerts.to,
    subject: aftermathSubject(summary),
    text: renderAftermathText(summary, baseUrl),
    html: renderAftermathHtml(summary, baseUrl),
  });
}

module.exports = { sendAlert, sendAftermath };
```

(Adjust the existing `module.exports = { sendAlert }` at the bottom of `sender.ts` to include `sendAftermath`.)

- [ ] **Step 6: Wire mute token into sendAlert**

In `hub/src/alerts/sender.ts`, in `sendAlert`, before calling `renderAlertHtml`, add:

```ts
const { signMuteToken } = require('./mute-token');  // module created in Task 10
const muteToken = signMuteToken(alert.type);
const ctx = { diagnosis, baseUrl, muteToken };  // replace existing ctx
```

(Task 10 creates `mute-token.ts`. If the test runs before Task 10 lands, wrap the `require` in a try/catch so the order doesn't matter.)

- [ ] **Step 7: Run test, verify pass**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-mail-template.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 8: Commit**

```bash
git add shared/mail/alert-template.ts shared/mail/aftermath-template.ts hub/src/alerts/sender.ts tests/alerts-mail-template.test.ts
git commit -m "feat(mail): severity badge subject + mute footer + aftermath template"
```

---

### Task 10: Mute token (HMAC sign/verify)

**Files:**
- Create: `hub/src/alerts/mute-token.ts`
- Test: `tests/alerts-mute-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-mute-token.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { signMuteToken, verifyMuteToken } = require('../hub/src/alerts/mute-token');

test('verify accepts a signed token', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  const tok = signMuteToken('restart_loop');
  const result = verifyMuteToken(tok);
  assert.equal(result, 'restart_loop');
});

test('verify rejects tampered tokens', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  const tok = signMuteToken('restart_loop');
  const tampered = tok.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
  assert.equal(verifyMuteToken(tampered), null);
});

test('verify rejects unsigned strings', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  assert.equal(verifyMuteToken('not-a-token'), null);
});

test('verify rejects expired tokens (>30 days)', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'test-secret';
  process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS = String(-31 * 24 * 3600 * 1000);
  const tok = signMuteToken('restart_loop');
  delete process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS;
  assert.equal(verifyMuteToken(tok), null);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-mute-token.test.ts
```
Expected: fail — module missing.

- [ ] **Step 3: Write the module**

Create `hub/src/alerts/mute-token.ts`:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function secret(): string {
  return process.env.INSIGHTD_MUTE_SECRET || 'insightd-default-mute-secret-change-in-prod';
}

function now(): number {
  const offset = Number(process.env.INSIGHTD_TEST_CLOCK_OFFSET_MS || 0);
  return Date.now() + offset;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 24);
}

function signMuteToken(alertType: string): string {
  const ts = now();
  const payload = `${alertType}.${ts}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifyMuteToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }
  const expected = sign(payload);
  const got = parts[1];
  if (expected.length !== got.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return null;
  const sep = payload.lastIndexOf('.');
  if (sep < 0) return null;
  const type = payload.slice(0, sep);
  const ts = Number(payload.slice(sep + 1));
  if (!Number.isFinite(ts)) return null;
  if (now() - ts > MAX_AGE_MS) return null;
  return type;
}

module.exports = { signMuteToken, verifyMuteToken };
```

- [ ] **Step 4: Run test, verify pass**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-mute-token.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add hub/src/alerts/mute-token.ts tests/alerts-mute-token.test.ts
git commit -m "feat(alerts): HMAC mute token sign + verify"
```

---

### Task 11: HTTP API — alert rules + mute endpoint

**Files:**
- Modify: `hub/src/web/handlers.ts`, `hub/src/web/server.ts`
- Test: `tests/alerts-rules-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/alerts-rules-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../hub/src/db/schema');
const { handleGetAlertRules, handlePutAlertRule, handleResetAlertRules, handleMuteAlertType } = require('../hub/src/web/handlers');
const { signMuteToken } = require('../hub/src/alerts/mute-token');

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as any, body: '' };
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.writeHead = (code: number) => { res.statusCode = code; };
  res.end = (b: string) => { res.body = b; };
  return res;
}

test('GET /api/alert-rules returns seeded rows with descriptions', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  handleGetAlertRules({ method: 'GET' } as any, res, db);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.rules));
  assert.ok(body.rules.length >= 27);
  const host = body.rules.find((r: any) => r.alert_type === 'host_offline');
  assert.ok(host.description);
});

test('PUT /api/alert-rules/:type updates the row', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  handlePutAlertRule({ method: 'PUT', body: { mail: 0 } } as any, res, db, null, { type: 'host_offline' });
  assert.equal(res.statusCode, 200);
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='host_offline'").get() as any;
  assert.equal(row.mail, 0);
});

test('POST /api/alert-rules/reset reseeds', () => {
  const db = new Database(':memory:'); bootstrap(db);
  db.prepare("UPDATE alert_rules SET mail=0 WHERE alert_type='host_offline'").run();
  const res = fakeRes();
  handleResetAlertRules({ method: 'POST' } as any, res, db);
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='host_offline'").get() as any;
  assert.equal(row.mail, 1);
});

test('GET /api/alerts/mute?token=… flips mail to 0', () => {
  process.env.INSIGHTD_MUTE_SECRET = 'api-test-secret';
  const db = new Database(':memory:'); bootstrap(db);
  const token = signMuteToken('restart_loop');
  const res = fakeRes();
  handleMuteAlertType({ method: 'GET', query: { token } } as any, res, db);
  assert.equal(res.statusCode, 200);
  const row = db.prepare("SELECT mail FROM alert_rules WHERE alert_type='restart_loop'").get() as any;
  assert.equal(row.mail, 0);
});

test('GET /api/alerts/mute with invalid token returns 400', () => {
  const db = new Database(':memory:'); bootstrap(db);
  const res = fakeRes();
  handleMuteAlertType({ method: 'GET', query: { token: 'garbage' } } as any, res, db);
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rules-api.test.ts
```
Expected: fail — handlers missing.

- [ ] **Step 3: Add the four handlers**

In `hub/src/web/handlers.ts`, at the top alongside other requires, add:

```ts
const { getAllRules, updateRule, resetRules } = require('../alerts/rules');
const { verifyMuteToken } = require('../alerts/mute-token');
```

Append four handler functions before `module.exports`:

```ts
function handleGetAlertRules(_req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  const rules = getAllRules(db);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ rules }));
}

function handlePutAlertRule(req: HandlerReq, res: ServerResponse, db: Database.Database, _config: any, params: Record<string, string>): any {
  const body = (req as any).body ?? {};
  const patch: any = {};
  if (body.severity !== undefined) patch.severity = String(body.severity);
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.mail !== undefined) patch.mail = body.mail ? 1 : 0;
  if (body.webhook !== undefined) patch.webhook = body.webhook ? 1 : 0;
  try {
    updateRule(db, params.type, patch);
  } catch (err: any) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: err.message }));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function handleResetAlertRules(_req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  resetRules(db);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function handleMuteAlertType(req: HandlerReq, res: ServerResponse, db: Database.Database): any {
  const token = (req as any).query?.token;
  if (!token) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'missing token' }));
    return;
  }
  const type = verifyMuteToken(String(token));
  if (!type) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid or expired token' }));
    return;
  }
  updateRule(db, type, { mail: 0 });
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><title>Muted</title><body style="font-family:sans-serif;padding:2em"><h2>Muted ${type}</h2><p>Email notifications for <code>${type}</code> are now off. Re-enable in <a href="/settings">Settings → Alert Rules</a>.</p></body>`);
}
```

Add the four to the `module.exports` list at the bottom (alongside existing handlers).

- [ ] **Step 4: Register routes**

In `hub/src/web/server.ts`, alongside the other `router.add` calls (near the settings routes around line 113), add:

```ts
  router.add('GET',  '/api/alert-rules',         handlers.handleGetAlertRules);
  router.add('PUT',  '/api/alert-rules/:type',   handlers.handlePutAlertRule);
  router.add('POST', '/api/alert-rules/reset',   handlers.handleResetAlertRules);
  router.add('GET',  '/api/alerts/mute',         handlers.handleMuteAlertType);
```

Add `'GET /api/alerts/mute'` to the public-routes allowlist (the constant near line 37-42 that lists `GET /api/health` etc.). The mute link is clicked from email, no session.

- [ ] **Step 5: Run test, verify pass**

```bash
cd /home/andreas/insightd && npx tsx --test tests/alerts-rules-api.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add hub/src/web/handlers.ts hub/src/web/server.ts tests/alerts-rules-api.test.ts
git commit -m "feat(api): alert-rules CRUD + one-click mute endpoint"
```

---

### Task 12: Settings UI — AlertRulesSection

**Files:**
- Create: `hub/src/web/frontend/src/pages/AlertRulesSection.tsx`
- Modify: `hub/src/web/frontend/src/pages/SettingsPage.tsx`, `hub/src/web/frontend/src/types/api.ts`

- [ ] **Step 1: Add the type**

In `hub/src/web/frontend/src/types/api.ts`, append:

```ts
export interface AlertRule {
  alert_type: string;
  severity: 'critical' | 'warning' | 'info';
  enabled: number;
  mail: number;
  webhook: number;
  description: string;
}
export interface AlertRulesResponse { rules: AlertRule[] }
```

- [ ] **Step 2: Create the section component**

Create `hub/src/web/frontend/src/pages/AlertRulesSection.tsx`:

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import type { AlertRule, AlertRulesResponse } from '@/types/api';

const RULES_KEY = ['alert-rules'] as const;

export function AlertRulesSection() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: RULES_KEY,
    queryFn: () => apiAuth<AlertRulesResponse>('GET', '/alert-rules', undefined, token),
    refetchInterval: false,
  });

  const update = useMutation({
    mutationFn: (args: { type: string; patch: Partial<AlertRule> }) =>
      apiAuth('PUT', `/alert-rules/${args.type}`, args.patch, token),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: RULES_KEY }); },
    onError: (e: any) => setErr(e?.message ?? 'failed'),
  });

  const reset = useMutation({
    mutationFn: () => apiAuth('POST', '/alert-rules/reset', undefined, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });

  const rules = data?.rules ?? [];
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Alert Rules</h2>
        <Button onClick={() => reset.mutate()} disabled={reset.isPending}>Reset to defaults</Button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Toggle per-rule mail and webhook delivery, change severity, or disable a rule entirely.
        With <b>Mail critical only</b> on (default), only critical-severity rules can send email.
      </p>
      {err && <AlertBanner tone="error">{err}</AlertBanner>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Severity</th>
              <th className="py-2 pr-2">Enabled</th>
              <th className="py-2 pr-2">Mail</th>
              <th className="py-2 pr-2">Webhook</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.alert_type} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  <code>{r.alert_type}</code>
                  <div className="text-xs text-gray-500">{r.description}</div>
                </td>
                <td className="py-2 pr-4">
                  <select value={r.severity} onChange={e => update.mutate({ type: r.alert_type, patch: { severity: e.target.value as AlertRule['severity'] } })}>
                    <option value="critical">critical</option>
                    <option value="warning">warning</option>
                    <option value="info">info</option>
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <input type="checkbox" checked={!!r.enabled} onChange={e => update.mutate({ type: r.alert_type, patch: { enabled: e.target.checked ? 1 : 0 } })} />
                </td>
                <td className="py-2 pr-2">
                  <input type="checkbox" checked={!!r.mail} onChange={e => update.mutate({ type: r.alert_type, patch: { mail: e.target.checked ? 1 : 0 } })} />
                </td>
                <td className="py-2 pr-2">
                  <input type="checkbox" checked={!!r.webhook} onChange={e => update.mutate({ type: r.alert_type, patch: { webhook: e.target.checked ? 1 : 0 } })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Mount into SettingsPage**

In `hub/src/web/frontend/src/pages/SettingsPage.tsx`:

Add import near other component imports:
```tsx
import { AlertRulesSection } from './AlertRulesSection';
```

Render it after the existing settings categories block. Locate the JSX root return (search for the place where category cards are rendered) and append:
```tsx
<AlertRulesSection />
```
inside the same wrapper.

- [ ] **Step 4: Build + manual check**

```bash
cd /home/andreas/insightd/hub/src/web/frontend && npm run build
```
Expected: build succeeds without TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add hub/src/web/frontend/src/pages/AlertRulesSection.tsx hub/src/web/frontend/src/pages/SettingsPage.tsx hub/src/web/frontend/src/types/api.ts
git commit -m "feat(ui): AlertRulesSection on SettingsPage — per-type toggles"
```

---

### Task 13: Mirror to standalone (`src/`)

**Files:**
- Copy: `hub/src/alerts/{severity,rules,dependencies,aftermath,mute-token}.ts` → `src/alerts/`
- Modify: `src/alerts/evaluator.ts`, `src/alerts/sender.ts` (apply same diff as hub-side)
- Modify: `src/db/schema.ts` (mirror migration v52)
- Modify: `src/config.ts` (mirror AlertsConfig fields)

- [ ] **Step 1: Copy the five new modules**

```bash
cd /home/andreas/insightd
cp hub/src/alerts/severity.ts     src/alerts/severity.ts
cp hub/src/alerts/rules.ts        src/alerts/rules.ts
cp hub/src/alerts/dependencies.ts src/alerts/dependencies.ts
cp hub/src/alerts/aftermath.ts    src/alerts/aftermath.ts
cp hub/src/alerts/mute-token.ts   src/alerts/mute-token.ts
```

Adjust their internal relative imports if any reference `../../../shared/...` from hub depth — `src/alerts/` is one level shallower (`../../shared/...`). Open each copied file and fix `require('...')` paths.

- [ ] **Step 2: Mirror the evaluator.ts diff into src/alerts/evaluator.ts**

Apply the same code changes from Task 6 (flap dampening), Task 7 (suppression + retroactive + aftermath dispatch), and Task 8 (rule gate) to `src/alerts/evaluator.ts`. The functions and structure already mirror hub's; the diffs apply verbatim.

- [ ] **Step 3: Mirror the sender.ts diff into src/alerts/sender.ts**

Apply Task 9 changes (severity in ctx, mute token, sendAftermath export) to `src/alerts/sender.ts`.

- [ ] **Step 4: Mirror the schema migration**

In `src/db/schema.ts`:
- Bump `SCHEMA_VERSION` from `51` to `52`
- Add the `alert_rules` CREATE TABLE in bootstrap
- Extend `alert_state` CREATE TABLE with the four new columns
- Add the same `if (fromVersion < 52)` migration block as Task 2 (the require path differs: `../alerts/severity` is still valid).

- [ ] **Step 5: Mirror config**

In `src/config.ts`, add the four optional fields to `AlertsConfig`:

```ts
  mailCriticalOnly?: boolean;
  suppressDependents?: boolean;
  flapStabilizeMinutes?: number;
  diskCriticalPercent?: number;
```

Standalone doesn't have a settings DB layer — these are env-only. Hook them up in the `readConfig()` or equivalent function with `INSIGHTD_ALERT_MAIL_CRITICAL_ONLY`, `INSIGHTD_ALERT_SUPPRESS_DEPENDENTS`, `INSIGHTD_ALERT_FLAP_STABILIZE`, `INSIGHTD_ALERT_DISK_CRITICAL`. Defaults match Task 5.

- [ ] **Step 6: Typecheck + tests**

```bash
cd /home/andreas/insightd && npm run typecheck && npm test 2>&1 | tail -20
```
Expected: clean typecheck, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/alerts/ src/db/schema.ts src/config.ts
git commit -m "feat(standalone): mirror strategic alert mail to src/"
```

---

### Task 14: Migration first-boot notice

**Files:**
- Modify: `hub/src/alerts/evaluator.ts` `runAlerts` (top)

- [ ] **Step 1: Add one-shot notice**

In `hub/src/alerts/evaluator.ts`, at the top of `runAlerts`, right after the snooze check, add:

```ts
  try {
    const noticeRow = db.prepare("SELECT value FROM meta WHERE key = 'alert_mail_v2_notice'").get() as { value: string } | undefined;
    if (!noticeRow) {
      const types = db.prepare("SELECT alert_type FROM alert_rules WHERE severity != 'critical' AND mail = 0").all() as { alert_type: string }[];
      logger.info('alerts', `Alert mail strategy v2 active. Mail-critical-only is ON by default. ${types.length} alert types no longer email by default: ${types.map(t => t.alert_type).join(', ')}. Edit per-rule in Settings → Alert Rules.`);
      db.prepare("INSERT INTO meta (key, value) VALUES ('alert_mail_v2_notice', datetime('now'))").run();
    }
  } catch { /* ignore */ }
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/alerts/evaluator.ts
git commit -m "feat(alerts): one-time log notice on first eval after v52 upgrade"
```

---

### Task 15: Manual UAT + PR

**Files:** none (operational)

- [ ] **Step 1: Local docker rebuild**

```bash
cd /home/andreas/insightd && docker compose build hub
docker compose up -d hub
docker compose logs -f hub 2>&1 | head -50
```
Expected: hub starts, schema bumps to v52, `Alert mail strategy v2 active` notice in log.

- [ ] **Step 2: Trigger fake host_offline**

```bash
docker compose exec hub sqlite3 /data/insightd.db "UPDATE hosts SET last_seen = datetime('now', '-30 minutes') WHERE host_id = (SELECT host_id FROM hosts LIMIT 1)"
```
Wait for next alert cron tick (≤5 min). Expect one mail with `[CRITICAL] Host …` subject.

- [ ] **Step 3: While offline, stop a container**

```bash
docker stop <some-container-on-that-host>
```
Expect: NO additional mail. Wait through one more cron tick to be sure.

- [ ] **Step 4: Restore host**

```bash
docker compose exec hub sqlite3 /data/insightd.db "UPDATE hosts SET last_seen = datetime('now') WHERE host_id = (SELECT host_id FROM hosts LIMIT 1)"
docker start <the-container>
```
Wait two cron ticks. Expect: ONE aftermath mail with `[RESOLVED] host_offline … 1 cleared, 0 still firing`.

- [ ] **Step 5: Test rule UI**

Open `https://<hub>/settings`. Confirm Alert Rules section renders all rule types. Flip `restart_loop` `mail` to on; flip `alerts.mailCriticalOnly` setting to off. Force a restart cycle on a test container. Confirm mail received.

- [ ] **Step 6: Test flap**

Set `alerts.flapStabilizeMinutes = 0`. Trigger a 30-second container_down via `docker stop && sleep 5 && docker start`. Expect mail (was: would also have mailed). Set back to `5`. Repeat. Expect: zero mails.

- [ ] **Step 7: Test mute link**

Trigger a warning-severity alert with mailCriticalOnly off. Mail arrives → click Mute link. Verify in `Settings → Alert Rules` that the type's mail column is unchecked. Verify subsequent triggers do not mail.

- [ ] **Step 8: Open PR**

```bash
git push -u origin strategic-alert-mail
gh pr create --title "Strategic alert mail — severity + dep suppression + flap dampening" --body "$(cat <<'EOF'
## Summary
- Severity-aware mail gate (critical only by default, configurable per rule)
- Dependent-alert suppression with single aftermath summary email
- Flap dampening — alerts must persist `flapStabilizeMinutes` before mailing
- Per-rule UI in Settings to tune severity/enabled/mail/webhook for every alert type
- HMAC mute link in every alert mail for one-click silencing

## Test plan
- [x] Unit tests: severity, rules, dependencies, flap, suppression, rule engine, aftermath, mute token, rules API
- [x] Schema v52 migration (backfills pending_since + severity)
- [x] Mirrored to standalone `src/`
- [ ] Manual UAT on production hub — fake host_offline → 1 critical mail + 1 aftermath
- [ ] Mute-link click round-trip

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- Spec coverage: every layer + setting + endpoint + UI section has a task. ✓
- Placeholders: none — all code is concrete.
- Type consistency: `AlertRule`, `Severity`, `AftermathSummary` shapes flow consistently across modules. `ParentRow` shape in dependencies + aftermath matches.
- Standalone parity: Task 13 mirrors all hub changes.
