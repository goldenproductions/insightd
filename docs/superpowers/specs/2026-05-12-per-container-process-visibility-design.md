# Per-container process visibility — design

**Issue:** [#264](https://github.com/goldenproductions/insightd/issues/264)
**Date:** 2026-05-12
**Status:** Design — awaiting review
**Scope:** v1 of #264. Process visibility subsystem only across host PID + Docker + k8s. Log-file visibility (the other half of #264) deferred to a sibling PR. UI deferred. Detectors (#262/#263) consume this data in their own PRs.

## Motivation

The agent today reports at the container boundary: CPU, memory, restart counts, stdout stream. It does not see processes inside each container or on the host PID namespace beyond what runtime APIs expose. This caps the precision of every higher-level detector. The Jellyfin field-validation case (318 ffmpeg respawns on a truncated mkv) demonstrated that container-level CPU + restart_count metrics are insufficient: container restart_count was 0 while a sub-process loop drove sustained 80% CPU. The respawn loop itself was the smoking gun.

This PR builds the data primitive: a per-process spawn/exit event stream from agent to hub, retained 7d, queryable by future detectors and explainers.

## Non-goals

- Respawn-loop detector (#262 — separate PR, consumes `process_events`).
- Log-pattern framework (#263 — separate PR).
- Container-internal log file tailing (deferred half of #264 — separate PR).
- UI surface (process list page on entity detail).
- eBPF / netlink event sources. Poll-only v1.
- CPU/RSS sampling for long-running processes. Spawn/exit only.
- argv argument anonymization (operator concern documented; future config knob).
- Cross-host process correlation.

## Architecture

```
┌──────────────────────────── agent (DaemonSet / Docker side-car) ────────────────────────────┐
│  ┌──────────────────────────┐                                                                │
│  │ process-poller (5s)      │   each cycle:                                                  │
│  │   collectors/processes.ts│     1. dockerTop()  → set<(pid, container_id, argv, comm)>     │
│  │                          │     2. crictlPs()   → set<(pid, pod_uid, container, argv...)>  │
│  │  emits spawn/exit events │     3. procWalk()   → set<(pid, argv, comm)>  (gap-fill only)  │
│  │  attribution: container  │     4. attribution: container source wins, host gap-fills      │
│  │     wins, host gap-fills │     5. diff vs previous cycle → spawns[] + exits[]             │
│  └────────────┬─────────────┘     6. argvHash + argv_dictionary deltas                       │
│               │                                                                              │
│               ▼                                                                              │
│  ┌──────────────────────────┐                                                                │
│  │ mqtt: process events     │   topic: insightd/<host_id>/process_events                     │
│  │   one msg per cycle      │   payload: { argv_defs[], spawns[], exits[] }                  │
│  └────────────┬─────────────┘                                                                │
└───────────────┼──────────────────────────────────────────────────────────────────────────────┘
                ▼
┌────────────────────────────────────── hub ──────────────────────────────────────────────────┐
│  mqtt.ts dispatch → ingest-process-events.ts                                                 │
│      INSERT OR IGNORE argv_dictionary (new hashes only)                                      │
│      INSERT OR IGNORE process_events (spawns)                                                │
│      UPDATE process_events SET exited_at, exit_code, lifetime_ms WHERE … (exits)             │
│                                                                                              │
│  scheduler.ts → pruneProcessEvents() (daily)                                                 │
│      DELETE process_events WHERE started_at < now - 7d                                       │
│      DELETE argv_dictionary WHERE hash unreferenced                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Boundary contract:** agent is stateful only within a single cycle (previous PID set). Restart = first cycle treats all observed PIDs as fresh spawns. Hub never sees process-tree snapshots; only deltas. `process_events` is an independent table — no joins required to insights/alerts schemas. Detectors (#262/#263) consume it in later PRs without coupling.

## Data model

Schema bumped to **v53** in `hub/src/db/schema.ts`. Migration block adds two tables idempotently.

```sql
-- One row per distinct argv hash ever seen. String-interning.
CREATE TABLE IF NOT EXISTS argv_dictionary (
  argv_hash   TEXT PRIMARY KEY,          -- sha256(argv_joined) first 16 hex chars
  argv        TEXT NOT NULL,             -- full argv, space-joined, capped 4096 bytes
  comm        TEXT NOT NULL,             -- basename(argv[0])
  first_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per observed process spawn. Exit fields filled when exit event arrives.
CREATE TABLE IF NOT EXISTS process_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id       TEXT NOT NULL,
  container_id  TEXT,                    -- NULL for host-PID-namespace processes
  pod_uid       TEXT,                    -- NULL unless k8s
  pid           INTEGER NOT NULL,
  ppid          INTEGER NOT NULL,
  argv_hash     TEXT NOT NULL,         -- soft reference to argv_dictionary.argv_hash; no FK (see below)
  started_at    TEXT NOT NULL,
  exited_at     TEXT,                    -- NULL = still alive (per last cycle)
  exit_code     INTEGER,                 -- NULL until exit observed
  lifetime_ms   INTEGER,                 -- denormalized at exit for detector queries
  source        TEXT NOT NULL,           -- 'docker' | 'k8s' | 'host'
  UNIQUE (host_id, pid, started_at)
);

CREATE INDEX IF NOT EXISTS idx_process_events_host_started
  ON process_events (host_id, started_at);
CREATE INDEX IF NOT EXISTS idx_process_events_container
  ON process_events (container_id, started_at) WHERE container_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_process_events_argv_hash
  ON process_events (argv_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_process_events_alive
  ON process_events (host_id, exited_at) WHERE exited_at IS NULL;
```

**Cardinality math:** worst-case 50 containers × 5 spawn/sec sustained = 21.6M rows/day. Realistic dogfood: ~1M/day across all hosts. 7d retention = ~7M rows steady-state. Indexes sized accordingly. Prune nightly. Argv hashes typically <1000 distinct per host; argv_dictionary stays small.

**Argv cap:** 4096 bytes truncates long argv. Hash computed on full argv pre-truncation (still unique). Truncated string stored for display.

**Why no FK on `argv_hash`:** hub runs with `PRAGMA foreign_keys = ON` (`hub/src/db/connection.ts`). Agent ships each new argv_hash once per session via `argv_defs[]`. On agent restart, the first cycle's spawns may reference hashes whose `argv_defs` haven't been re-shipped yet (agent is stateless about which hashes hub already knows). Enforcing the FK would fail those inserts; relaxing it lets the spawn rows land, and a subsequent message will populate the dictionary. Detector and UI queries LEFT JOIN `argv_dictionary` and tolerate NULL argv strings. Retention prune handles the relationship: argv_dictionary entries are only deleted when no `process_events` row references them.

## Shared types

New file `shared/types/process-events.ts` (mirrored to `src/` per repo convention).

```typescript
export interface ArgvDef {
  argv_hash: string;
  argv: string;
  comm: string;
}

export interface SpawnEvent {
  pid: number;
  ppid: number;
  argv_hash: string;
  started_at: string;          // ISO-8601 UTC
  source: 'docker' | 'k8s' | 'host';
  container_id?: string;
  pod_uid?: string;
}

export interface ExitEvent {
  pid: number;
  started_at: string;          // join key with prior spawn
  exited_at: string;
  exit_code: number | null;    // null when /proc disappeared before stat read
  lifetime_ms: number;
}

export interface ProcessEventPayload {
  cycle_at: string;
  argv_defs: ArgvDef[];
  spawns: SpawnEvent[];
  exits: ExitEvent[];
}
```

## Agent collector

**New file:** `agent/src/collectors/processes.ts`. Cycle 5s. Configurable.

```typescript
interface ObservedProcess {
  pid: number;
  ppid: number;
  argv: string;          // space-joined, truncated 4096
  argvHash: string;      // sha256(full argv) first 16 hex chars
  comm: string;
  startedAt: string;     // ISO; derived from /proc/<pid>/stat field 22 (jiffies) + boot time
  source: 'docker' | 'k8s' | 'host';
  containerId?: string;
  podUid?: string;
}

async function pollOnce(): Promise<ObservedProcess[]> {
  const dockerPids = await viaDockerTop();   // Map<pid, {containerId, ...}>
  const k8sPids    = await viaCrictl();      // Map<pid, {podUid, ...}> — empty if runtime != k8s
  const claimed    = new Set([...dockerPids.keys(), ...k8sPids.keys()]);
  const hostPids   = await viaProcWalk(claimed);  // /proc only for unclaimed PIDs

  return [...dockerPids.values(), ...k8sPids.values(), ...hostPids];
}
```

**Diff key** is `(pid, startedAt)`, not pid alone. PID reuse across cycles is real; `startedAt` from `/proc/<pid>/stat` makes the key stable.

- New keys → spawn events (with full attribution).
- Vanished keys → exit events. Read `/proc/<pid>/stat` for exit_code if still readable; else null. `lifetime_ms = now - startedAt`.

**Argv dictionary deltas:** agent maintains `Set<argvHash>` of hashes shipped this session. New hashes get an `argv_defs[]` payload entry; subsequent events reference only the hash.

**Acquisition details:**
- `viaDockerTop()`: `docker top <id> -eo pid,ppid,comm,args` per running container. Parallel with `Promise.all`, soft-timeout 2s per container. Skipped containers logged once per container per hour.
- `viaCrictl()`: `crictl inspect <containerId>` → root pid; walk `/proc/<pid>/task/*/children` for descendants. Skipped entirely if `runtime.kind !== 'kubernetes'`.
- `viaProcWalk(claimed)`: read `/proc/[0-9]*/`. Filter kernel threads via `PF_KTHREAD` bit in `/proc/<pid>/stat` field 9. Skip PIDs in `claimed`. Parses `/proc/<pid>/cmdline` (NUL-separated).

**MQTT payload** (topic `insightd/<host_id>/process_events`, QoS 0, one message per cycle):

```typescript
{
  cycle_at: '2026-05-12T10:00:00Z',
  argv_defs: [{ argv_hash, argv, comm }],
  spawns:    [{ pid, ppid, argv_hash, started_at, source, container_id?, pod_uid? }],
  exits:     [{ pid, started_at, exited_at, exit_code, lifetime_ms }]
}
```

**k8s prerequisite:** crictl binary on agent image PATH. Add to Dockerfile (alpine: `apk add crictl` or pinned curl). Absent at startup → log once, disable k8s source for session, continue with host + Docker.

**Host /proc prerequisite:** agent in DaemonSet bind-mounts `/proc:/host/proc:ro` and reads from `/host/proc`. Reuse existing pattern from `agent/src/collectors/host.ts`.

## Hub ingest

**New file:** `hub/src/ingest-process-events.ts` (sibling to existing `ingest.ts`).

**MQTT route:** subscribe to `insightd/+/process_events` in `hub/src/mqtt.ts`. Handler dispatches to `ingestProcessEvents(db, hostId, payload)`.

```typescript
export function ingestProcessEvents(db: Database, hostId: string, payload: ProcessEventPayload) {
  const tx = db.transaction(() => {
    const argvIns = db.prepare(`
      INSERT OR IGNORE INTO argv_dictionary (argv_hash, argv, comm) VALUES (?, ?, ?)
    `);
    for (const def of payload.argv_defs ?? []) {
      argvIns.run(def.argv_hash, def.argv.slice(0, 4096), def.comm);
    }

    const spawnIns = db.prepare(`
      INSERT OR IGNORE INTO process_events
        (host_id, container_id, pod_uid, pid, ppid, argv_hash, started_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of payload.spawns ?? []) {
      spawnIns.run(hostId, s.container_id ?? null, s.pod_uid ?? null,
                   s.pid, s.ppid, s.argv_hash, s.started_at, s.source);
    }

    const exitUpd = db.prepare(`
      UPDATE process_events
         SET exited_at = ?, exit_code = ?, lifetime_ms = ?
       WHERE host_id = ? AND pid = ? AND started_at = ? AND exited_at IS NULL
    `);
    for (const e of payload.exits ?? []) {
      exitUpd.run(e.exited_at, e.exit_code ?? null, e.lifetime_ms,
                  hostId, e.pid, e.started_at);
    }
  });
  tx();
}
```

**Conflict semantics:**
- Spawn duplicate (replay after agent reconnect): `UNIQUE(host_id, pid, started_at)` plus `INSERT OR IGNORE` → no-op.
- Exit on never-seen spawn (agent missed the spawn cycle): UPDATE affects zero rows. Drop silently. Acceptable data loss.
- Exit on already-exited row: `WHERE exited_at IS NULL` guards. No-op.

**Backpressure / cost guard:** reject and log any message with `>MAX_EVENTS_PER_MESSAGE` (default 10000) total entries across `spawns + exits + argv_defs`. Agent should never emit that much per cycle; treat as protocol abuse.

## Retention

Extend `hub/src/scheduler.ts` with a daily job:

```typescript
function pruneProcessEvents(db: Database) {
  db.exec(`DELETE FROM process_events WHERE started_at < datetime('now', '-7 days')`);
  db.exec(`
    DELETE FROM argv_dictionary
     WHERE argv_hash NOT IN (SELECT DISTINCT argv_hash FROM process_events)
  `);
}
```

Same cadence as existing snapshot pruners. Hold WAL checkpoint after.

## Config

`agent/src/config.ts` additions:

```typescript
processCollection: {
  enabled: boolean;           // default true
  pollIntervalMs: number;     // default 5000
  argvMaxBytes: number;       // default 4096
  dockerTopTimeoutMs: number; // default 2000 per container
}
```

Env overrides: `INSIGHTD_PROCESS_ENABLED`, `INSIGHTD_PROCESS_INTERVAL_MS`, `INSIGHTD_PROCESS_ARGV_MAX`, `INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS`. Match existing collector toggle pattern.

## Error handling

| Failure | Behavior |
|---|---|
| `docker top` non-zero for one container | Skip container this cycle. Log once per container per hour. |
| Docker daemon unreachable | Skip Docker source this cycle. Re-probe next cycle. |
| crictl binary missing at startup | Log once. Disable k8s source for session. |
| `/proc/<pid>/cmdline` empty (kthread or race with exit) | Skip the PID silently. |
| `/proc/<pid>/stat` unparseable | Skip PID. Bump cycle-error counter. |
| MQTT publish fails | Buffer in agent memory ring buffer (max 60 cycles ≈ 5 min). Older evicted. |
| Hub `process_events` table missing (migration not run) | Hub rejects, logs schema mismatch. Agent treats as transient, keeps buffering. |
| Ingest message exceeds `MAX_EVENTS_PER_MESSAGE` | Reject the entire message, log. No partial ingest. |
| Spawn references unknown argv_hash | Insert proceeds (`argv_hash` is a plain column, no FK — see Data model section). The argv_dictionary row may arrive in a later message during agent-restart races. Detector and UI queries LEFT JOIN argv_dictionary and tolerate NULL argv display strings. |
| Cycle exceeds 4s budget on a 50-container host | Skip next cycle, log once per minute when skips occur. |

## Testing

**Agent (`agent/test/processes.test.ts`):**
- `viaDockerTop` parsing fixture asserts pid/ppid/argv extraction, handles spaces in argv.
- `viaProcWalk` fixture `/proc` dir: kernel threads dropped, claimed PIDs skipped, cmdline NUL handling.
- Cycle diff: previous PID set + next cycle adds 2 PIDs and removes 1 → spawn[2] + exit[1].
- PID reuse: same pid, different started_at across cycles → distinct spawns.
- Argv dictionary lifecycle: hash emitted only on first occurrence per session.
- Cycle skip on overrun: poll takes >4s → next cycle skipped, counter increments.
- Backpressure: MQTT down for 6 cycles → 6 buffered; eviction at synthetic small cap.

**Hub (`hub/test/ingest-process-events.test.ts`):**
- Argv dictionary upsert idempotency.
- Spawn idempotency via UNIQUE constraint.
- Exit applied → row has exited_at, exit_code, lifetime_ms.
- Orphan exit (no prior spawn) → no-op, no error.
- Double exit → second is no-op.
- Prune: rows older than 7d gone; argv_dictionary GCs orphaned hashes.
- Oversize message rejected.

**Integration (`tests/`):**
- docker-compose stack: agent + hub. Spawn `bash -c 'while true; do sleep 0.1; ls > /dev/null; done'` in a test container. After 30s assert `process_events` ≥100 `ls` rows with non-null `exited_at`, `exit_code = 0`.

## Observability

- Agent metrics (Prometheus, existing pattern): `insightd_agent_process_cycles_total`, `insightd_agent_process_cycle_duration_seconds` (histogram), `insightd_agent_process_cycle_skipped_total`, `insightd_agent_process_spawns_emitted_total`, `insightd_agent_process_buffer_size`.
- Hub metrics: `insightd_hub_process_events_ingested_total`, `insightd_hub_process_events_orphan_exits_total`, `insightd_hub_argv_dictionary_size`.

## Risks

| Risk | Mitigation |
|---|---|
| 5s poll misses tight respawn loops (<5s lifetime) | Documented limitation. Future eBPF/netlink can replace poller without schema change. |
| Argv contains secrets (CLI tokens) | Documented. Future config knob `processCollection.argvRedactRegexes`. Not in v1. |
| Cardinality explosion on high-churn hosts | 7d prune + UNIQUE constraint cap. Worst-case row size measured during integration test. |
| `docker top` fork cost on 100+ container hosts | 2s soft-timeout per container, parallel exec, skip cycle on overrun. |
| crictl missing in agent image breaks k8s users | Startup probe + fallback to host-only attribution. |
| PID reuse race within a single 5s cycle | `started_at` derived from `/proc/<pid>/stat` jiffies → distinct values across reuse. |

## Open questions

None blocking v1. Items to revisit after first deployment:
- Whether to keep the `lifetime_ms` denormalization or compute from `(exited_at - started_at)` on query.
- Whether `cycle_at` belongs in the payload or can be inferred from receipt time at hub.
- Whether to upgrade poll cadence default from 5s to 3s after measuring real-world cost.
