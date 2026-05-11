# Strategic Alert Mail

**Date:** 2026-05-11
**Status:** Draft — pending implementation plan
**Author brainstorm:** Andreas

## Problem

Email alerts arrive one-per-event with no severity gating, no dependent
suppression, and no flap dampening. A single overnight incident (host
down, network blip, restart loop) can produce 20+ emails by morning,
desensitizing the operator and obscuring the actionable signal.

Today's behavior (`hub/src/alerts/evaluator.ts:processAlerts`):

- Every `(host_id, alert_type, target)` is its own state row.
- First trigger → email immediately.
- Reminders → exponential backoff (1h → 2h → 4h … cap 24h) per row.
- Resolutions → email immediately, every time.
- No coordination between rows. No severity.

A host going offline with 12 containers therefore emits at minimum
13 trigger emails plus 13 resolution emails. Flapping doubles each.

## Goals

1. **Quiet by default.** Mail only for problems the operator needs to
   wake up for.
2. **Configurable.** Severity, channel, and on/off must be tunable per
   alert type by the user — defaults are opinionated but not locked in.
3. **Storm-aware.** Root cause emails once; dependents stay silent until
   the root resolves, then arrive as one consolidated aftermath email.
4. **Flap-resistant.** Brief blip + recovery emits no mail at all.
5. **Webhook channel unaffected.** Power users keep instant-everything
   via ntfy / Discord / Slack if they want.

## Non-goals

- Re-architecting the cron loop or moving to event-driven dispatch.
- Per-recipient routing (one inbox for now).
- Quiet-hours / time-of-day batching (could be a later layer).
- Rich digest mail redesign (the existing weekly digest stays as-is).
- Mobile push or SMS channels.

## Architecture

Four orthogonal layers, applied in order during `processAlerts`:

```
evaluator.checks → triggered/resolved → processAlerts
                                              │
                                              ▼
                            ┌─────────────────────────────────┐
                            │  1. Rule lookup (severity, mail,│
                            │     webhook, enabled)           │
                            ├─────────────────────────────────┤
                            │  2. Flap dampening              │
                            │     (pending_since gate)        │
                            ├─────────────────────────────────┤
                            │  3. Dependent suppression       │
                            │     (parent active? → suppress) │
                            ├─────────────────────────────────┤
                            │  4. Reminder backoff (existing) │
                            └─────────────────────────────────┘
                                              │
                                              ▼
                                     mail / webhook dispatch
```

Each layer can be turned off independently via settings.

## Layer 1 — Severity tagging + mail filter

### Static severity map

Single source of truth in `hub/src/alerts/severity.ts`:

```ts
const DEFAULT_SEVERITY: Record<string, 'critical' | 'warning' | 'info'> = {
  // Critical — site/host broken, mail by default
  host_offline:             'critical',
  container_down:           'critical',
  workload_unavailable:     'critical',
  endpoint_down:            'critical',
  pve_cluster_quorum_lost:  'critical',
  node_not_ready:           'critical',
  pve_zfs_unhealthy:        'critical',
  cert_expired:             'critical',
  disk_full:                'critical', // gated by diskCriticalPercent
  pve_storage_saturation:   'critical', // ditto
  image_pull_failure:       'critical',

  // Warning — investigate, no mail by default
  restart_loop:                  'warning',
  high_cpu:                      'warning',
  high_memory:                   'warning',
  container_memory_saturation:   'warning',
  container_cpu_saturation:      'warning',
  high_host_cpu:                 'warning',
  low_host_memory:               'warning',
  high_load:                     'warning',
  container_unhealthy:           'warning',
  node_pressure:                 'warning',
  workload_degraded:             'warning',
  workload_rollout_stuck:        'warning',
  pod_pending:                   'warning',
  cert_expiring_soon:            'warning',
  cert_invalid:                  'warning',
  pve_backup_overdue:            'warning',
};
```

### Configurable per-rule overrides

New table:

```sql
CREATE TABLE alert_rules (
  alert_type  TEXT PRIMARY KEY,
  severity    TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  mail        INTEGER NOT NULL,
  webhook     INTEGER NOT NULL DEFAULT 1
);
```

Migration v34 creates the table and seeds one row per known alert type
from `DEFAULT_SEVERITY`. `mail` defaults: 1 for critical, 0 for warning/info.

`getRule(db, type)` returns the row; missing rows (new alert type
introduced after migration) fall back to the static map.

### Disk-full severity gate

The single `disk_full` alert type carries either severity depending on
the live percent. Add a setting:

- `alerts.diskCriticalPercent` (int, default `95`) — at/over this, the
  alert is treated as critical for the mail filter. Below it, treated
  as warning regardless of the rule row.

Apply the same gate to `pve_storage_saturation`.

### Mail filter logic

```ts
function shouldMail(alert, rule, settings): boolean {
  if (!rule.enabled) return false;
  if (!rule.mail) return false;
  if (!settings.mailCriticalOnly) return true;
  return effectiveSeverity(alert, rule) === 'critical';
}
```

`effectiveSeverity` returns the rule's severity, except for `disk_full`
and `pve_storage_saturation` which downgrade to `warning` when below
`diskCriticalPercent`.

### New settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `alerts.mailCriticalOnly` | bool | `true` | Global gate: when on, only critical-severity alerts can mail (per-rule `mail` still required). |
| `alerts.diskCriticalPercent` | int | `95` | Disk usage % at/over which `disk_full` and `pve_storage_saturation` count as critical. |

## Layer 2 — Flap dampening

### State columns

`alert_state` gains:

- `pending_since TEXT` — when the current "triggered" side was first
  observed. Set on initial INSERT; cleared on resolution.
- `resolved_pending_since TEXT NULL` — when the transition to resolved
  was first observed. Cleared if the alert retriggers before
  stabilization completes.

### Behavior

Configured by `alerts.flapStabilizeMinutes` (int, default `5`, `0`
disables).

**On trigger:**

| State | Action |
|-------|--------|
| No row | INSERT with `pending_since = now`, `notify_count = 0`. **No mail.** |
| Row exists, `notify_count = 0`, `now - pending_since >= stableMin` | Mail initial alert, `notify_count = 1`, `last_notified = now`. |
| Row exists, `notify_count = 0`, still in window | Hold — no mail. |
| Row exists, `notify_count > 0` | Existing reminder-backoff path unchanged. |
| Row exists, `resolved_pending_since IS NOT NULL` | Clear `resolved_pending_since` (alert came back before stabilizing). No state-side mail. |

**On resolution detection (alert no longer triggered):**

| State | Action |
|-------|--------|
| `notify_count = 0` | Initial alert never went out — silently DELETE the row. No resolution mail. |
| `resolved_pending_since IS NULL` | Set `resolved_pending_since = now`. No mail. |
| `now - resolved_pending_since >= stableMin` AND `now - last_notified >= stableMin` | Mail resolution; set `resolved_at = now`. |

Resolutions inherit the rule's `mail` flag — if mail was suppressed for
trigger, resolution stays silent too.

### Trade-off

Real alerts arrive `stableMin` minutes later. Acceptable because:

1. The cron is already 5 min by default, so we double worst-case latency.
2. Webhook channel does *not* go through this gate — set up ntfy for
   instant push if you need real-time.
3. The default is configurable down to 0.

## Layer 3 — Dependent suppression

### Dependency map

Static in `hub/src/alerts/dependencies.ts`:

```ts
type ScopeKey = 'host' | 'cluster';

interface Dep {
  parent: string;       // alert type
  scope: ScopeKey;      // how to match parent ↔ child
  children: string[];   // alert types swallowed while parent active
}

const DEPS: Dep[] = [
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
```

Cluster-scoped parents match children by `proxmox_cluster_id`, resolved
via the existing `hosts.proxmox_cluster_id` column (PR #253).

### State column

`alert_state` gains:
- `suppressed_by_state_id INTEGER NULL REFERENCES alert_state(id)` —
  pointer to the active parent row. Set when a child fires while parent
  is already active. Cleared on resolution.

### Logic in `processAlerts`

```ts
for (const alert of triggered) {
  const parent = findActiveParent(db, alert);  // null if none
  // … flap-dampening gate first (layer 2) …
  if (parent && settings.suppressDependents) {
    upsertChildState(alert, suppressedBy: parent.id);
    continue;  // no mail, no webhook
  }
  // normal mail/webhook path
}
```

`findActiveParent` query joins `alert_state` to `hosts` for cluster
scope:

```sql
SELECT s.id FROM alert_state s
LEFT JOIN hosts h ON h.host_id = s.host_id
WHERE s.alert_type = ?      -- parent type
  AND s.resolved_at IS NULL
  AND s.pending_since IS NOT NULL  -- already exists, even if pre-mail
  AND CASE :scope
        WHEN 'host'    THEN s.host_id = ?
        WHEN 'cluster' THEN h.proxmox_cluster_id = ?
      END
LIMIT 1;
```

### Retroactive suppression

If the parent fires *after* its children (network partition: container
metrics stop, then host_offline triggers), the parent's first-fire
handler scans for already-active alerts on the same scope that match
its children list and stamps `suppressed_by_state_id` on them. Those
children's resolution mails are then routed through the aftermath
path instead of as individual resolution emails.

### Aftermath email

When a parent resolves, emit a single consolidated mail covering all
its suppressed children:

```
Subject: ✅ Host "proxmox-01" back — 12 dependent alerts (10 cleared, 2 still firing)

Body:
  Root cause resolved: host_offline → cleared 09:14.
  Duration offline: 47 minutes.

  Still firing on this host:
    • container_down: postgres (since 08:42)
    • restart_loop:   redis (12 restarts in 30 min)

  Cleared in parallel with host:
    • container_down: nginx, traefik, grafana, prometheus,
      node-exporter, blackbox-exporter, watchtower, dozzle,
      portainer, uptime-kuma  (10 containers)
```

Implementation: at resolution time, `SELECT * FROM alert_state WHERE
suppressed_by_state_id = ?`. Partition by `resolved_at IS NULL`. Render
both sections. Send one mail.

Resolved-while-parent-was-active children skip their normal individual
resolution mail.

### New setting

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `alerts.suppressDependents` | bool | `true` | Suppress mails for child alerts when their root-cause parent is active; send one aftermath summary when parent resolves. |

## Layer 4 — Settings UI + admin API

### Settings page

New "Alert Rules" subsection on `SettingsPage`, below the existing
Alerts block:

**Master toggles** (existing setting fields, just relocated):
- `Mail critical only` (bool)
- `Suppress dependents` (bool)
- `Flap stabilize (min)` (int)
- `Disk critical threshold (%)` (int)

**Per-rule table:**

| Type | Severity | Enabled | Mail | Webhook |
|---|---|---|---|---|
| host_offline | [critical ▾] | [✓] | [✓] | [✓] |
| container_down | [critical ▾] | [✓] | [✓] | [✓] |
| restart_loop | [warning ▾] | [✓] | [ ] | [✓] |
| high_cpu | [warning ▾] | [✓] | [ ] | [✓] |
| … | | | | |

Per-row info icon → tooltip with the alert's trigger description
(pulled from a static label/description map kept alongside
`DEFAULT_SEVERITY`).

`Reset to defaults` button → `POST /api/alert-rules/reset`.

### API

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/alert-rules` | — | Returns all rule rows + their descriptions. |
| PUT | `/api/alert-rules/:type` | `{severity?, enabled?, mail?, webhook?}` | Updates one row. |
| POST | `/api/alert-rules/reset` | — | Truncates `alert_rules`, re-seeds from defaults. |

Auth: same as existing settings (admin session or API key with
appropriate role). Rate-limited via existing middleware.

### Mail subject + footer

Subject prefix carries severity:

```
[CRITICAL]  Host "proxmox-01" has not reported in 17 minutes
[WARNING]   Container "redis" on proxmox-01 restarted 5 times in 30 min  (only sent if user opted in)
```

Footer adds:

```
─────────
Mute this alert type   |   Snooze 1 hour   |   Alert settings
```

`Mute this alert type` → preauthed URL with a token (HMAC over
`alert_type + secret`) that flips `alert_rules.mail` to 0 for that
type. No login required from the click — the token is the auth.
`Snooze 1 hour` reuses existing `alert-snooze` module. `Alert settings`
deep-links to the rule table.

### Schema migration (v34)

```sql
-- alert_rules table + seed
CREATE TABLE alert_rules (...);
INSERT INTO alert_rules (alert_type, severity, enabled, mail, webhook)
VALUES (...);  -- one row per known alert type

-- alert_state columns
ALTER TABLE alert_state ADD COLUMN severity TEXT;
ALTER TABLE alert_state ADD COLUMN pending_since TEXT;
ALTER TABLE alert_state ADD COLUMN resolved_pending_since TEXT;
ALTER TABLE alert_state ADD COLUMN suppressed_by_state_id INTEGER REFERENCES alert_state(id);
```

Existing rows on upgrade: `pending_since` backfilled to `triggered_at`,
`severity` backfilled from the seeded `alert_rules` row.

## Webhook channel

**Webhooks are not gated by `mailCriticalOnly` or by flap dampening.**
Webhook dispatch happens at evaluation time on every triggered alert
(before the layers above), gated only by `alert_rules.webhook` per
type and `alert_rules.enabled`. Rationale: webhook destinations (ntfy
phone push, Discord channel, Slack #alerts) want real-time signal;
the user already chose those channels for visibility, not for inbox
hygiene.

Dependent suppression *does* skip webhooks for child alerts (same
parent-active gate) — otherwise the root-cause aftermath problem
returns in webhook form. This is the only layer that filters both
channels.

## Testing

New tests in `tests/`:

- `tests/alerts-flap-dampening.test.ts`
  - 3-min flap → zero mails
  - 6-min outage + 6-min recovery → exactly two mails (trigger, resolution)
  - Flap exactly at stabilizeMinutes boundary
  - `flapStabilizeMinutes = 0` → instant mail (back-compat)
- `tests/alerts-dependent-suppression.test.ts`
  - host_offline → 12 container_down: 1 mail (host), 0 children
  - Parent fires after children: retroactive suppression + aftermath
  - Aftermath split: some children resolved with parent, some still firing
  - `suppressDependents = false` → all mails fire (back-compat)
  - Cluster-scoped parent (pve_cluster_quorum_lost) suppresses cluster children only, not unrelated hosts
- `tests/alerts-rule-engine.test.ts`
  - `mailCriticalOnly = true` + warning rule with mail=1 → no mail
  - `mailCriticalOnly = false` + warning rule with mail=1 → mail sent
  - `enabled = false` → neither mail nor webhook fires
  - `disk_full` at 92% with `diskCriticalPercent=95` → treated warning → no mail
  - `disk_full` at 96% → treated critical → mail
- `tests/alerts-rules-api.test.ts`
  - GET returns seeded rows
  - PUT updates a row, GET reflects the change
  - POST reset wipes overrides
  - Mute-token URL flips `mail` to 0

Manual UAT on dev VM after deploy:

1. Trigger fake host_offline via `UPDATE hosts SET last_seen = datetime('now','-30 minutes')`. Confirm one mail.
2. While offline, stop a container — confirm no extra mail.
3. Restore host last_seen → expect single aftermath mail listing the container.
4. Flip `restart_loop` rule mail=1 + `mailCriticalOnly=false`. Force a restart cycle. Expect mail for restart_loop.
5. Toggle `flapStabilizeMinutes = 0`, force a 30-second flap. Expect 2 mails (was: 0).
6. Mute-link click flips `mail` to 0 in DB; verify no further mails of that type.

## Rollout

- Single PR, schema migration v34.
- Default settings preserve current behavior in the *most user-visible*
  way only if they keep `mailCriticalOnly = false`. We are intentionally
  flipping the default to `true` because that's the whole point — but
  the migration logs a one-time `WARN` listing the alert types whose
  mail just turned off, and emits a single "Alert mail behavior changed
  — see settings" notification on first eval cycle after upgrade.
- Backout: setting `mailCriticalOnly=false`, `suppressDependents=false`,
  `flapStabilizeMinutes=0` reproduces today's behavior without code
  changes.

## Open questions

None blocking. Possible follow-ups:

- Per-recipient routing (route critical to one address, warnings to
  another). Could re-use `alert_rules` with a `recipient` column.
- Quiet hours (batch non-critical inside 22:00–07:00). Independent
  layer on top of severity.
- Aftermath email customization (subject template, body sections).
