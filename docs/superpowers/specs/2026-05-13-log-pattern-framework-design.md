# Log-pattern framework — design

**Issue:** [#263](https://github.com/goldenproductions/insightd/issues/263)
**Date:** 2026-05-13
**Status:** Design — awaiting review
**Scope:** Second consumer of `process_events` foundation (PR #267) and the third detector layered onto the May 2026 detector framework (after #261 strategic alert mail and #275 respawn-loop detector). Container stdout/stderr only in this PR. Container-internal log file tailing (linuxserver convention) is a known prerequisite for some patterns but is deferred to a follow-up PR — the framework lands without depending on it.

## Motivation

Many production-grade pathologies have a known, specific log signature that points directly at the root cause. In the May 2026 Jellyfin validation case (PR #275), the smoking gun was a single line inside the container:

```
[matroska,webm @ 0x...] File ended prematurely
```

That line was unambiguous, image-specific, and would have told the operator the cause in zero clicks. Today the closest insightd has is `hub/src/insights/diagnosis/templateClassifier.ts` — 17 generic semantic tags (`oom`, `panic`, `conn_refused`, …) hardcoded in TypeScript. The classifier works on Drain-mined templates, not raw lines; it has no image-aware dispatch, no capture groups, no first-class evidence rendering, and no path for community-contributed patterns.

This PR adds the image-specific, YAML-driven, first-class layer on top — without disturbing the existing generic classifier.

## Non-goals

- **Container-internal log file tailing.** Some target log signatures (Jellyfin's `FFmpeg.*.log`, linuxserver-style apps) live in files inside containers, not on stdout. That requires a separate agent-side capability (deferred half of #264 / a sibling issue). The framework here matches on whatever logs are already available in `logCache`; patterns whose only source is an internal file will not fire until tailing lands. This is documented in CONTRIBUTING.md.
- **Streaming / scheduled log pulls.** No new bandwidth. Matches run on log batches that the existing pipeline already fetches — unhealthy transition pre-warm, container-detail page load, manual diagnose. If a pattern is only ever proven by a log line that arrives between fetch triggers, this PR does not catch it. Acceptable trade-off documented in Out of scope below.
- **UI for editing patterns.** YAML registry only. A DB-backed user-editable patterns table is a possible follow-up.
- **Drain classifier replacement.** Existing semantic tags continue to power diagnosers as today. The new framework is additive.
- **Alert suppression of explained alerts.** A matched pattern that explains an alert stamps the alert row (rich UI affordance) but does not suppress the alert. Operators still see the visible symptom.

## Architecture

```
┌──── shared/log-patterns/ (curated YAML registry, in-repo) ────┐
│  jellyfin.yaml         images: [*jellyfin*, …]                 │
│  CONTRIBUTING.md       YAML schema + acceptance criteria       │
└──────────────┬─────────────────────────────────────────────────┘
               │ hub boot: load + validate (eager regex compile)
               ▼
┌──────────────── hub/src/log-patterns/ ────────────────────────┐
│  loader.ts    parse YAML → in-memory image index               │
│  matcher.ts   line[] + image → MatchEvent[]                    │
│  events.ts    log_pattern_events DB read/write                 │
└──┬──────────────────────────────────┬──────────────────────────┘
   │                                  │
   │ (on log batch written)           │ (on insight cycle)
   ▼                                  ▼
┌──── logCache.ts ────┐    ┌──── insights/detector.ts ────┐
│ writeLogs():        │    │ generateInsights():           │
│  → templateClassif  │    │  → read log_pattern_events    │
│  → matcher.run()    │    │    last 24h                   │
│  → events.record    │    │  → group by (host,cont,pat)   │
└─────────────────────┘    │  → insert insight rows        │
                           │    category=logs, metric=     │
                           │    log_pattern_match          │
                           └───────────────────────────────┘
                                          │
                                          ▼
                       ┌──── alerts/evaluator.ts ────┐
                       │ processAlerts():            │
                       │  on new alert_state INSERT  │
                       │  events.findForAlertType    │
                       │  → UPDATE alert_state SET   │
                       │    explained_by_pattern_… = │
                       └─────────────────────────────┘
```

**Boundary contract.** The matcher is a pure function `matchLines(lines, image, registry) → MatchEvent[]`. `logCache.ts`, `generateInsights`, and `processAlerts` interact with the registry only through `events.ts`. The Drain classifier path is untouched — image-specific patterns and generic semantic tags coexist.

## Components

### New files

- `shared/log-patterns/jellyfin.yaml` — first pattern set: matroska premature end, FFmpeg fatal, transcode timeout.
- `shared/log-patterns/CONTRIBUTING.md` — YAML schema reference, acceptance criteria for new pattern files, regex hygiene rules (anchor; prefer literal substrings; avoid catastrophic backtracking; one PR per image preferred; reproducer in PR description).
- `hub/src/log-patterns/types.ts` — interfaces `Pattern`, `Registry`, `MatchEvent`.
- `hub/src/log-patterns/loader.ts` — `loadRegistry(rootDir): Registry`. Parses every `*.yaml` in `rootDir`, validates schema, compiles regexes eagerly, builds image-keyed index. Validation failures = warning log + file skipped (no boot crash). Globally unique `pattern_id` enforced (duplicate rejected with logged warning).
- `hub/src/log-patterns/matcher.ts` — `matchLines(lines: LogLine[], image: string, registry: Registry): MatchEvent[]`. Iterates lines once, applies pre-compiled regexes per applicable pattern (image-indexed), extracts named captures via JS regex groups, attaches up to N=3 context lines before/after.
- `hub/src/log-patterns/events.ts` — `recordMatch(db, event)` UPSERTs into `log_pattern_events` (UNIQUE key collapses repeats of identical lines into an `occurrences` bump). `findRecent(db, hostId, containerName, sinceIso, patternIds?)` for diagnoser consumers. `findForAlertType(db, alertType, hostId, target, sinceIso)` for the alert-stamping path.
- `hub/src/web/frontend/src/components/insights/LogMatchBlock.tsx` — new component rendered by `ExpandedBody.tsx`'s existing extras dispatch. Matched line monospace + context as `<pre>` + captures as a labeled rows table.
- Test files:
  - `hub/tests/log-patterns/loader.test.ts`
  - `hub/tests/log-patterns/matcher.test.ts`
  - `hub/tests/log-patterns/events.test.ts`
  - `hub/tests/integration/log-patterns-pipeline.test.ts`

### Edited files

- `hub/src/insights/diagnosis/logCache.ts` — after `templateClassifier` template mining writes templates, call `matcher.matchLines(lines, image, registry)` and persist via `events.recordMatch`. Registry passed in via the existing `LogCacheContext` (already carries `db` + image).
- `hub/src/insights/detector.ts` — at end of `generateInsights`, read `log_pattern_events` from last 24h, group by `(host_id, container_name, pattern_id)`, insert `insights` rows with `entity_type='container'`, `entity_id='${host_id}/${container_name}'`, `category='logs'`, `severity = pattern.severity ?? 'warning'`, `metric='log_pattern_match'`, evidence JSON containing the most recent match payload + occurrence count.
- `hub/src/alerts/evaluator.ts:processAlerts` — when a new `alert_state` row is INSERTed, immediately call `events.findForAlertType(db, alert.type, alert.hostId, alert.target, '-15 minutes')`. If a hit exists: `UPDATE alert_state SET explained_by_pattern_event_id = ? WHERE id = ?`. One-time stamp on first matching event; subsequent matches don't overwrite.
- `hub/src/insights/explain.ts` — branch on `metric === 'log_pattern_match'` to emit a `log_match` extras block (no special chart; reuse `sparkline` of `occurrences` over time or omit chart and rely on extras).
- `hub/src/insights/explain-types.ts` — add `LogMatchBlock` to `ExtraBlock` discriminated union.
- `hub/src/web/frontend/src/types/api.ts` — mirror `LogMatchBlock` (with `Explain` prefix per existing convention).
- `hub/src/web/frontend/src/components/insights/ExpandedBody.tsx` — extras dispatch already handles arbitrary block kinds; add `block.kind === 'log_match'` branch returning the new `LogMatchBlock` component.
- Alerts page component (under `hub/src/web/frontend/src/pages/alerts/`) — alert row renders a small "↳ likely cause: <pattern.title>" chip when `explained_by_pattern_event_id` is non-null. Implementer locates the row-rendering component at implementation time and threads the new field + chip through it.
- `hub/src/db/schema.ts` — schema v54: new table `log_pattern_events` + new nullable column `alert_state.explained_by_pattern_event_id`. Standalone `src/db/schema.ts` mirrored.
- `hub/src/config.ts` — env knobs:
  - `INSIGHTD_LOG_PATTERNS_ENABLED` (default `true`)
  - `INSIGHTD_LOG_PATTERNS_DIR` (default `shared/log-patterns`)
  - `INSIGHTD_LOG_PATTERN_RETENTION_DAYS` (default `7`)
- `hub/src/db/prune.ts` (or whichever module runs the 03:30 cron) — `DELETE FROM log_pattern_events WHERE fired_at < datetime('now', '-N days')`.
- `package.json` — add `js-yaml` (`^4.x`) + `@types/js-yaml`. Not currently a dependency — verify before adding.

## YAML schema + example

```yaml
# shared/log-patterns/jellyfin.yaml
images:
  - "*jellyfin*"
title: "Jellyfin"
patterns:
  - id: media_file_corrupted
    title: "Media file ended prematurely"
    description: >
      ffmpeg or libavformat reports the input file ended before the declared
      duration. Usually means a truncated source (incomplete download, broken
      transfer) or misreported metadata duration. Jellyfin retries on every
      playback, causing visible respawn loops.
    regex: 'File ended prematurely|Premature end of (?:file|stream)'
    captures: []
    severity: warning
    insight_category: logs
    explains_alert:
      - respawn_loop
      - container_unhealthy

  - id: ffmpeg_fatal
    title: "FFmpeg fatal error"
    description: "Unrecoverable ffmpeg error during transcode."
    regex: '\[fatal\]\s+(?<message>.+)'
    captures:
      - message
    severity: warning
    insight_category: logs
    explains_alert:
      - respawn_loop

  - id: transcode_timeout
    title: "Transcode segment timeout"
    description: "Jellyfin transcoder dropped a segment after waiting too long."
    regex: 'Transcode segment .*? timed out after (?<seconds>\d+) seconds'
    captures:
      - seconds
    severity: warning
    insight_category: logs
    explains_alert: []
```

**Schema rules enforced by loader:**

- `images: string[]` required, ≥1 entry. Each entry is a substring match (no regex on image strings in v1) against the container's `image` field with tag stripped (`linuxserver/jellyfin:latest` → `linuxserver/jellyfin`). Leading/trailing `*` denote substring boundaries; absent `*` means exact match after tag strip.
- `patterns[].id` required, kebab-case, globally unique across registry.
- `patterns[].regex` required, JavaScript-flavor. Loader compiles eagerly with `new RegExp(...)`. Compilation failure = pattern skipped with warning, other patterns in the same file still load.
- `patterns[].captures` optional. Declares the named groups expected in the regex. Loader validates names appear in the compiled regex's `groups` shape (warning if missing — pattern still loads).
- `patterns[].severity` in `{info, warning, critical}`. Default `warning`.
- `patterns[].insight_category` defaults to `logs`. Restricted to insight categories already present in `chartKindForCategory` (i.e. existing renderable categories).
- `patterns[].explains_alert` optional. Array of `alert_type` strings. Loader does NOT validate that the alert types exist (forward-compat).
- Unknown YAML fields warn the loader (catches typos).

## Data model

**Schema v54 additions** (pure additive, no destructive changes):

```sql
CREATE TABLE log_pattern_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id            TEXT NOT NULL,
  container_name     TEXT NOT NULL,
  image              TEXT,
  pattern_id         TEXT NOT NULL,
  matched_line       TEXT NOT NULL,
  context_before     TEXT,            -- JSON array of strings
  context_after      TEXT,            -- JSON array of strings
  captures           TEXT,            -- JSON object: named group -> value
  line_hash          TEXT NOT NULL,   -- sha256(pattern_id || '\n' || matched_line).slice(0,16)
  fired_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
  occurrences        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (host_id, container_name, pattern_id, line_hash)
);

CREATE INDEX idx_lpe_container ON log_pattern_events (host_id, container_name, fired_at DESC);
CREATE INDEX idx_lpe_pattern   ON log_pattern_events (pattern_id, fired_at DESC);

ALTER TABLE alert_state ADD COLUMN explained_by_pattern_event_id INTEGER;
```

**No FK on `explained_by_pattern_event_id`.** Retention prune removes old events before alerts resolve; the dangling reference must be harmless. UI renders alerts with a missing-event reference as if no chip were set (or as `(explanation expired)`, implementer's choice).

Standalone `src/db/schema.ts` mirrors the same additions for the single-container Docker mode.

## Data flow

1. **Hub boot.** `loader.loadRegistry(INSIGHTD_LOG_PATTERNS_DIR)` parses every `*.yaml`, validates, builds `Map<imageMatcher, Pattern[]>` plus a flat `Pattern[]`. Result kept in module-level singleton. Validation failures = warning + file skipped (boot never crashes). Reload-on-signal deferred.
2. **Log batch arrives in cache.** `logCache.writeLogs(...)` runs as today: Drain mining + `templateClassifier`. New step: `matcher.matchLines(lines, container.image, registry)` runs. For each line, the image-indexed patterns get applied; each match becomes a `MatchEvent`.
3. **Event recorded.** For each `MatchEvent`, compute `line_hash = sha256(pattern_id || '\n' || matched_line).slice(0,16)`. The `UNIQUE(host_id, container_name, pattern_id, line_hash)` constraint collapses repeats:
   - First occurrence: `INSERT` new row with `occurrences = 1`.
   - Repeat of the same `(container, pattern, line)`: `UPSERT` bumps `occurrences = occurrences + 1` and refreshes `last_seen_at`. No new row. `matched_line` stays from the first fire (they're identical anyway since line_hash matches), `captures` updated if newer captures differ.
   - Each insight materializes a single row per `(container, pattern_id)` even if multiple distinct `line_hash` values exist; the most recent event's evidence is used, and `occurrences` aggregates across all line_hashes of that pattern in the window.
4. **Insight cycle.** `generateInsights` reads `log_pattern_events` from the trailing 24h, GROUP BY `(host_id, container_name, pattern_id)`, ORDER BY `fired_at` DESC. For each group, materialize one insight using the most recent event's evidence + total `occurrences` over the window. Insight columns: `entity_type='container'`, `entity_id='${host_id}/${container_name}'`, `category='logs'`, `severity = pattern.severity`, `metric='log_pattern_match'`, evidence JSON.
5. **Alert cycle.** When `processAlerts` INSERTs a new `alert_state` row (or the retroactive-suppression path matches a pre-existing alert), call `events.findForAlertType(db, alert.type, alert.hostId, alert.target, '-15 minutes')` returning rows whose pattern declares `explains_alert ∋ alert.type`. On first hit: `UPDATE alert_state SET explained_by_pattern_event_id = ? WHERE id = ?`. Subsequent matches do NOT overwrite (the explanation is sticky).
6. **UI.**
   - **Insights tab / dashboard feed** — `category='logs'` insight rows render via the existing card pattern; clicking opens explain → `LogMatchBlock` extras shows matched line + context + captures.
   - **Alerts page** — alert row with `explained_by_pattern_event_id` non-null displays a small "↳ likely cause: <pattern.title>" chip that opens the corresponding insight (or a focused view of the pattern event). Implementer picks whichever fits the existing alerts UI without restructuring.

## Error handling + edge cases

- **YAML parse failure** — file skipped, warning logged with file path + error. Other files still load. Boot never crashes on bad YAML.
- **Regex compilation failure** — pattern skipped within its file; other patterns in the same file still load. Warning names the offending `pattern_id`.
- **Catastrophic backtracking / ReDoS** — pre-compile regexes (loader does this); CONTRIBUTING.md flags pitfalls; the matcher records its total time per batch and logs a warning if it exceeds 100ms, naming the slowest pattern. Hard circuit-breaker deferred to a follow-up.
- **Empty registry** — `INSIGHTD_LOG_PATTERNS_ENABLED=false` or missing/empty directory → matcher is a no-op. logCache and insight cycle still call into the module; it returns early with no work.
- **No log lines / log fetch failed** — matcher receives `[]`, returns `[]`. No events written.
- **Container image unknown** (e.g. local build with no tag) — matcher iterates all patterns and applies image substring matching; if no `images:` entry matches, that pattern's regex never runs.
- **Line longer than 4KB** — matcher truncates to 4KB before regex; truncation marker `…[truncated]` appended in the evidence `matched_line` so the UI can show it.
- **Context lines insufficient** at batch boundary — `context_before` / `context_after` may be shorter than N=3. UI renders what's available.
- **Captures missing at runtime** — regex compiled but capture group didn't fire on this particular match. `captures` stores only groups that captured. UI hides absent labels.
- **Multiple patterns match the same line** — all matches recorded as separate events. Each materializes its own insight. If patterns are redundant (operator misconfig), the registry surfaces it via dual insights — fix in YAML.
- **Repeat-line UPSERT** — same `(container, pattern, line_hash)` re-fires → bump `occurrences` + `last_seen_at`. No new event row. Insight reflects the latest `matched_line` and the cumulative `occurrences`.
- **`explained_by_pattern_event_id` references deleted event** — UI tolerates: alert renders without the chip. No crash on JOIN.
- **Container rename mid-window** — `host_id + container_name` is the join key. Renames break attribution; same limitation as existing alerts. Out of scope here.
- **Hub restart** — registry reloaded. In-memory state lost (none kept). DB events survive. Cooldown still works via DB row.
- **YAML registry directory missing** in dev environment — loader returns empty registry, warning logged once at boot.

## Testing

### Unit — loader (`hub/tests/log-patterns/loader.test.ts`)

- Valid `jellyfin.yaml` loads → registry has 3 patterns indexed under `*jellyfin*`.
- Missing `images` field → file skipped with logged warning.
- Malformed regex → pattern skipped; sibling patterns in the same file still load.
- Duplicate `pattern_id` across two files → second occurrence rejected with logged warning.
- Capture name declared but absent in regex → warning logged; pattern still loads.
- Unknown YAML field → warning; pattern still loads.
- Empty directory → empty registry; no crash.

### Unit — matcher (`hub/tests/log-patterns/matcher.test.ts`)

- Single line match: `File ended prematurely` → `MatchEvent` with correct `pattern_id`, `matched_line`, `line_hash`.
- Captures populated when groups fire: `[fatal] foo bar` against `\[fatal\]\s+(?<message>.+)` → `captures.message === 'foo bar'`.
- Context window N=3: line at position 5 of 10 → `context_before = lines[2..4]`, `context_after = lines[6..8]`.
- Context at batch edge: line at position 0 → `context_before = []`.
- Line >4KB truncated, marker appended to evidence.
- Image doesn't match any registry entry → returns `[]`.
- Image matches multiple patterns → all hits returned as separate `MatchEvent`s.

### Unit — events (`hub/tests/log-patterns/events.test.ts`)

- `recordMatch`: first insert → row created with `occurrences=1`.
- `recordMatch` repeat of same line: same `line_hash` → UPSERT bumps `occurrences=2`, refreshes `last_seen_at`, no new row.
- `recordMatch` with a different `line_hash` (different matched line for same pattern) → new row alongside the first.
- `findRecent`: returns events for container within window, excludes older.
- `findForAlertType`: only returns events whose pattern declares `explains_alert ∋ type`.

### Integration — full pipeline (`hub/tests/integration/log-patterns-pipeline.test.ts`)

- Bootstrap real hub schema.
- Stub registry in-memory: `{ images: ['*jellyfin*'], patterns: [{ id: 'media_file_corrupted', regex: 'File ended prematurely', explains_alert: ['respawn_loop'] }] }`.
- Simulate `logCache.writeLogs` with a synthetic batch including the matching line.
- Assert `log_pattern_events` row exists with correct payload.
- Trigger `generateInsights` → assert `insights` row with `category='logs'`, `metric='log_pattern_match'`, evidence contains matched line.
- Seed conditions for a `respawn_loop` firing on the same container; trigger `evaluateAlerts` + `processAlerts` → assert the resulting `alert_state` row has `explained_by_pattern_event_id` set to the recorded event's id.

### Manual on vdev

- Confirm `jellyfin.yaml` patterns load (boot log).
- Trigger an unhealthy state on a Jellyfin container playing a deliberately-truncated mkv; confirm the log fetch on unhealthy transition surfaces the pattern, the insight appears with `LogMatchBlock`, and the `respawn_loop` alert (if firing concurrently per PR #275) gets the "↳ likely cause" chip.

## Rollout

- Default enabled (`INSIGHTD_LOG_PATTERNS_ENABLED=true`); empty registry is a safe no-op.
- Existing installs migrate via the schema v54 step on hub start.
- No agent changes. No MQTT topic changes.
- `js-yaml` added to hub dependencies. Bundle size impact small (~30 KB).
- CONTRIBUTING.md goes in `shared/log-patterns/` to invite pattern contributions.

## Out of scope (this PR)

- Container-internal log file tailing (linuxserver convention). Some patterns will not fire until that lands.
- Scheduled or streaming log pulls outside the existing trigger set.
- DB-backed user-editable patterns via UI.
- Hard ReDoS circuit-breaker. Soft 100ms warning only.
- File-watch / live reload of the registry. Hub restart required to pick up new YAML files.
- Per-pattern cooldown override in YAML (single global cooldown env knob in v1).
- Validation of `explains_alert` against real alert types (forward-compat).
- Pattern severity overlay onto `effectiveSeverity` (insight severity comes straight from YAML; alert severity is unaffected — see Non-goals).
- Cross-link in glossary: add "log pattern" + "explained by" terms in a follow-up.

## Open follow-ups

- Pattern UI editor + DB-backed custom patterns.
- Container-internal log file tailing (the prerequisite for the linuxserver-style use case).
- Hard ReDoS guard.
- Pattern rate-limit telemetry — surface "this pattern fires N times/min" so contributors can tune.
- Pre-built pattern packs for postgres / nginx / redis / traefik / mosquitto — community PRs invited via CONTRIBUTING.md.
