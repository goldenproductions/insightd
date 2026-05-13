# Respawn-loop detector — design

**Issue:** [#262](https://github.com/goldenproductions/insightd/issues/262)
**Date:** 2026-05-13
**Status:** Design — awaiting review
**Scope:** First consumer of `process_events` (PR #267, schema v53). Container-only first cut; k8s pod respawn detection deferred to a sibling PR. Log-pattern framework (#263) is independent and out of scope.

## Motivation

The Jellyfin field-validation case in May 2026 demonstrated the gap: a truncated mkv broke the cluster index at 48:30, but the file's metadata claimed 67 minutes. Jellyfin handed the segment to ffmpeg, ffmpeg failed at 48:30, Jellyfin retried — 318 times. Container `restart_count` was 0 the whole time. Container CPU was pegged at >80%. The only signal that told the operator "this isn't a tuning problem, this is an application-level crash loop" was the process-level spawn pattern: same `ffmpeg -i <file>` argv, ~318 spawns per hour, each <10 seconds long.

PR #267 shipped the data primitive (`process_events` + `argv_dictionary`). This PR turns that data into an actionable signal: an alert and an insight whenever a container is wedged in a process respawn loop, with the offending argv visible at a glance.

It also closes a long-standing false-positive class on `container_cpu_high`: respawn loops cause sustained CPU symptoms, but the user-facing root cause is the loop, not the container's CPU budget. The respawn-loop alert suppresses `container_cpu_high` and `container_memory_high` as dependent symptoms via the DEPS map introduced in PR #261.

## Non-goals

- **k8s pod respawn detection.** `process_events.pod_uid` is populated, but Kubernetes already has CrashLoopBackOff + pod-status alerts (project_insightd_k8s_gaps roadmap, landed). Process-level pod respawn detection is a follow-up PR.
- **Lifetime histogram chart kind.** Defer to a follow-up. First cut reuses `restart_histogram` (PR #258).
- **Cron-pattern false-positive suppression.** Rely on per-rule mute via the Alert Rules UI (PR #261). If field validation surfaces FPs, follow-up adds whichever guard matches the real pattern (interval-variance, image allowlist, etc.).
- **Per-rule threshold parameters in `alert_rules`.** First cut uses env knobs. If operators need per-container thresholds, schema extension is a follow-up.
- **New schema migration.** Pure additive logic over schema v53.

## Architecture

```
┌──────────────────────── hub (1-minute rule eval cron) ────────────────────────┐
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────┐              │
│  │ hub/src/alerts/respawn-loop.ts                              │              │
│  │   findActiveRespawnLoops(db, now) → RespawnLoopGroup[]      │              │
│  │   single SQL aggregate over process_events                  │              │
│  │   thresholds from env (WINDOW_MIN, MIN_SPAWNS,              │              │
│  │     SHORT_LIFETIME_MS, SHORT_LIFETIME_RATIO)                │              │
│  └─────────────┬───────────────────────┬───────────────────────┘              │
│                │                       │                                       │
│        alert path                insight path                                  │
│                ▼                       ▼                                       │
│  ┌──────────────────────┐   ┌──────────────────────────┐                       │
│  │ evaluator.ts         │   │ insights/detector.ts     │                       │
│  │   route each group → │   │   for each group:        │                       │
│  │   alert_state upsert │   │     fetch top_argvs      │                       │
│  │   severity=warning   │   │     upsert into insights │                       │
│  │   flap damp (#261)   │   │     kind=respawn_loop    │                       │
│  └─────────┬────────────┘   └──────────────┬───────────┘                       │
│            │                               │                                   │
│            ▼                               ▼                                   │
│  alert_state row             insights row (availability category)              │
│  + DEPS suppression of                                                         │
│    container_cpu_high                                                          │
│    container_memory_high                                                       │
└────────────────────────────────────────────────────────────────────────────────┘
                                ▼
              UI: Alerts page + Insights tab + container detail
              Explain: restart_histogram (hourly spawns) + top_argvs table
```

**Boundary contract.** `findActiveRespawnLoops` is a pure function of (db, now). Same call from alert path and insight path yields the same groups → alert and insight stay consistent without coordination state. No tables added. No agent changes. Insight de-dup key includes `argv_hash`, so distinct loops in the same container produce distinct insights.

## Data model

No schema changes. Reuses:

- `process_events` (PR #267): `(host_id, container_id, pod_uid, pid, argv_hash, started_at, exited_at, exit_code, lifetime_ms, source)`
- `argv_dictionary` (PR #267): `(argv_hash, argv, comm, first_seen)`
- `alert_state` (PR #261): existing flap damp + dependent suppression
- `alert_rules` (PR #261): seeded with one new row for `container_respawn_loop`
- `insights` (existing): new `kind='respawn_loop'`, `category='availability'`

## Detection logic

**Group-level trigger** — fires for `(container_id, argv_hash)` pairs over the trailing window:

```sql
WITH recent AS (
  SELECT container_id, argv_hash, lifetime_ms
    FROM process_events
   WHERE container_id IS NOT NULL
     AND started_at >= datetime(?, '-' || ? || ' minutes')
     AND exited_at IS NOT NULL
     AND lifetime_ms IS NOT NULL
)
SELECT
  container_id,
  argv_hash,
  COUNT(*) AS spawn_count,
  AVG(CASE WHEN lifetime_ms < ? THEN 1.0 ELSE 0.0 END) AS short_ratio,
  AVG(lifetime_ms) AS avg_lifetime_ms
FROM recent
GROUP BY container_id, argv_hash
HAVING spawn_count >= ? AND short_ratio >= ?
```

Params: `(now, WINDOW_MIN, SHORT_LIFETIME_MS, MIN_SPAWNS, SHORT_LIFETIME_RATIO)`.

**Defaults (env-tunable):**

| Env var                                | Default | Meaning                                                    |
| -------------------------------------- | ------- | ---------------------------------------------------------- |
| `INSIGHTD_RESPAWN_WINDOW_MIN`          | `15`    | Lookback window in minutes                                 |
| `INSIGHTD_RESPAWN_MIN_SPAWNS`          | `20`    | Minimum spawn count of same argv_hash in window            |
| `INSIGHTD_RESPAWN_SHORT_LIFETIME_MS`   | `10000` | Lifetime threshold below which a spawn is "short"          |
| `INSIGHTD_RESPAWN_SHORT_LIFETIME_RATIO`| `0.6`   | Minimum fraction of spawns that must be short to trigger   |

Rationale: matches Jellyfin signal shape (318/hour easily clears 20/15min, all <10s lifetime). Cuts out cron/Jenkins-style "many short jobs with diverse argvs" because aggregation is per-argv_hash. Cuts out healthcheck-loop FPs only if intervals are dense enough — known limitation, mitigated by per-rule mute.

**Top-argvs evidence** — separate query per firing group, joined to `argv_dictionary` for argv string + comm:

```sql
SELECT pe.argv_hash, ad.argv, ad.comm,
       COUNT(*) AS cnt, AVG(pe.lifetime_ms) AS avg_lt
  FROM process_events pe
  JOIN argv_dictionary ad ON ad.argv_hash = pe.argv_hash
 WHERE pe.container_id = ?
   AND pe.started_at >= datetime(?, '-15 minutes')
 GROUP BY pe.argv_hash
 ORDER BY cnt DESC
 LIMIT 5
```

Argv truncated to 200 chars in evidence JSON. Full argv remains in `argv_dictionary` and accessible via explain API on demand.

## Components

**New file:**
- `hub/src/alerts/respawn-loop.ts` — exports `findActiveRespawnLoops(db, now)`, types `RespawnLoopGroup`, `TopArgv`, plus helper `fetchTopArgvs(db, containerId, now)` for insight enrichment.

**Edited files:**
- `hub/src/alerts/evaluator.ts` — wire `container_respawn_loop` rule eval. Route each `RespawnLoopGroup` to `alert_state` upsert with key `(container_respawn_loop, container_id, argv_hash)`.
- `hub/src/alerts/rules.ts` — seed default row: `{ kind: 'container_respawn_loop', enabled: 1, mail: 0, severity: 'warning' }`. (Mail off by default per `mailCriticalOnly` philosophy from PR #261; operator opts in via Settings → Alert Rules.)
- `hub/src/alerts/severity.ts` — register `container_respawn_loop` → warning.
- `hub/src/alerts/dependencies.ts` — DEPS map: `container_respawn_loop` → `[container_cpu_high, container_memory_high]`, scope = container.
- `hub/src/insights/detector.ts` — for each firing group, call `fetchTopArgvs`, upsert into `insights` with category=`availability`, kind=`respawn_loop`, evidence `{ argv_hash, spawn_count, short_ratio, avg_lifetime_ms, top_argvs: [...] }`.
- `hub/src/insights/explain.ts` — for kind=`respawn_loop`: emit `restart_histogram` chart (24 hourly buckets of spawn count for the firing argv_hash) + `top_argvs` block.
- `hub/src/insights/explain-types.ts` — add `TopArgvsBlock` discriminated union member.
- `hub/src/web/frontend/.../InsightExplain.tsx` (or wherever explain blocks render) — render `top_argvs` table block: columns = comm, spawn count, avg lifetime (ms), argv (truncated, monospace, copyable).
- `shared/config/*` — register env knobs above, defaults, validation.
- Standalone `src/db/schema.ts` mirror — no change this PR (no schema diff).

## Data flow

1. Agent emits `process_events` MQTT messages (PR #267, existing).
2. Hub `ingest-process-events.ts` writes `process_events` + `argv_dictionary` rows (existing).
3. Hub rule eval cron (1min, existing): `findActiveRespawnLoops(db, now)` → groups.
4. evaluator.ts routes each group → `alert_state` upsert. Flap damp from PR #261 holds the alert until `pending_since` age ≥ `flapStabilizeMinutes`.
5. If alert ultimately fires and `rule.mail=1`, mail goes via existing pipeline.
6. DEPS map suppresses `container_cpu_high` + `container_memory_high` on the same container while `container_respawn_loop` is firing. Retroactive stamp from PR #261 handles ordering races.
7. Hub insight materialization cron (existing cadence): same fn → upsert `insights` rows, evidence populated via `fetchTopArgvs`.
8. UI: alert shows on Alerts page + dashboard feed; insight shows on Insights tab + container detail page (per PR #260). Clicking insight → explain endpoint serves `restart_histogram` + `top_argvs` blocks.

## Error handling + edge cases

- **No process_events** (host without collector enabled or new install) — query returns 0 rows, fn returns `[]`. Logged at debug.
- **Still-running spawns** (`exited_at IS NULL`) — excluded from the aggregate. Only completed spawns count. Avoids long-running processes inflating spawn counts.
- **Missing `lifetime_ms`** — defensive filter `lifetime_ms IS NOT NULL` even though ingest populates it.
- **PID reuse within window** — `process_events` keys on `(host_id, pid, started_at)`, so reuse is already distinct rows; no app-side dedup needed.
- **Container deleted mid-window** — argv_hash still groups by `container_id`. Alert fires once on the final cycle, resolves naturally when the 15min window slides past the last spawn.
- **Clock skew between agents** — query anchors on hub-side `datetime('now')`. `started_at` is the agent's clock (existing behavior); for clean homelab clocks (NTP) this is fine. Severe skew is an existing observability problem outside this PR's scope.
- **Argv length** — `argv_dictionary.argv` capped at 4096 bytes on insert (PR #267). Evidence further truncates to 200 chars for UI display. Full argv via explain API.
- **Rule disabled mid-cycle** — existing evaluator gates routing on `alert_rules.enabled`. Insight path runs unconditionally (insights have no per-rule kill switch today; matches existing pattern).
- **Hub restart** — fn is stateless; first cycle after restart re-evaluates against the existing 15min window. Re-fires existing-but-resolved alerts; flap damp absorbs the bounce.

## Testing

**Unit (`hub/tests/alerts/respawn-loop.test.ts`, new):**
- In-memory better-sqlite3 with schema v53.
- Seed `process_events` + `argv_dictionary` rows; use `Date.now()`-relative timestamps (avoid hardcoded dates that time-bomb).
- Cases:
  - 19 spawns same argv (below MIN_SPAWNS) → no fire.
  - 20 spawns, 59% short-lifetime → no fire.
  - 20 distinct argv_hashes, 1 spawn each (cron-style diversity) → no fire.
  - 25 spawns same argv, all <5s → fires (Jellyfin-shaped).
  - Same argv across 2 containers, 25 spawns each → 2 distinct groups.
  - 25 spawns with `exited_at IS NULL` → no fire (still-running excluded).
  - Window-boundary: spawn at `now - 15min + 1ms` included; spawn at `now - 15min - 1ms` excluded.
  - Env override: `INSIGHTD_RESPAWN_MIN_SPAWNS=5` lowers bar — fires at 5 spawns.

**Unit (`fetchTopArgvs`):**
- 3 argv_hashes with spawn counts (50, 10, 1) → returns ordered DESC, LIMIT 5, joined with `comm` and truncated argv.

**Unit (`hub/src/alerts/dependencies.ts`):**
- Extend existing DEPS test to verify `container_respawn_loop` → `[container_cpu_high, container_memory_high]`, scope=container.
- Verify retroactive stamp + aftermath summary path (reuse PR #261 test scaffolding) — when respawn-loop fires after CPU-high is already firing, CPU-high gets `suppressed_by_state_id` retroactively.

**Integration (`tests/integration/respawn-loop-e2e.test.ts`, new — gated by `RUN_E2E`):**
- Reuse compose stack from `tests/integration/process-events-e2e.test.ts`.
- Alpine victim spawning a short-lived crashing process at 0.5s interval, e.g. `sh -c "while true; do sleep 0.3; (exit 1); done"`.
- Wait ~90s (15min window not required when MIN_SPAWNS lowered via env for the test).
- Assert: `alert_state` row exists for `(container_respawn_loop, container_id, argv_hash)`.
- Assert: `insights` row exists, kind=respawn_loop.
- Assert: GET `/api/insights/:id/explain` returns `top_argvs` block with the spawning argv.

**Manual on vdev:**
- Trigger respawn loop in a test container; verify insight card renders `top_argvs` table with copyable argv and `restart_histogram` chart of hourly spawns.
- Trigger respawn loop while CPU-high would also fire; verify only the respawn-loop alert is visible, and CPU-high shows the `suppressed_by` state.

## Rollout

- Default rule seed: enabled=1, mail=0, severity=warning. New installs start collecting and surfacing in UI without paging.
- Existing installs: rule seed runs via existing `alert_rules` migration helper (PR #261 pattern).
- Operator opt-in for mail via Settings → Alert Rules.
- No breaking changes. Pure additive.

## Open follow-ups (not this PR)

- k8s pod respawn detection — use `coalesce(container_id, pod_uid)` aggregation key, scope=pod for insights/alerts.
- Lifetime histogram chart kind — new `lifetime_histogram` in explain renderer for clearer "all spawns short" visualization.
- FP guards once field-validated — cron-interval evenness, image allowlist, or per-rule threshold params in `alert_rules`.
- Cross-link in glossary: add "respawn loop" term with `<GlossaryHelp>` icon next to insight card title.
