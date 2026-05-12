# Per-container process visibility — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spawn/exit event pipeline (agent collector → MQTT → hub ingest → SQLite + retention) so that detectors in later PRs (#262, #263) have per-process visibility to query.

**Architecture:** Agent polls Docker (`docker top`), k8s (`crictl` + `/proc/<pid>/task/*/children`), and host `/proc` every 5s, dedupes by attribution priority (container source wins), diffs against previous cycle, ships spawn/exit deltas via MQTT topic `insightd/<host_id>/process_events`. Hub stores in two new tables (`argv_dictionary`, `process_events`) with 7-day retention.

**Tech Stack:** TypeScript, node:test, better-sqlite3, mqtt, dockerode (already in tree). New external binary in agent image: `crictl`.

**Companion spec:** `docs/superpowers/specs/2026-05-12-per-container-process-visibility-design.md`

**Branch:** `feat/process-visibility` (the spec already landed on `feat/process-visibility-spec`; rebase or branch off main and cherry-pick the spec commit before starting).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `shared/types/process-events.ts` | Wire-format types (ArgvDef, SpawnEvent, ExitEvent, ProcessEventPayload). Used by both agent and hub. Mirrored to `src/types/process-events.ts` per repo convention. |
| `hub/src/ingest-process-events.ts` | `ingestProcessEvents(db, hostId, payload)` — argv dict upsert + spawn insert + exit update in one transaction. |
| `agent/src/collectors/processes/argvHash.ts` | `hashArgv(argv: string): string` — sha256 first 16 hex chars, applied to full pre-truncation string. |
| `agent/src/collectors/processes/procWalk.ts` | `walkProc(opts): ObservedProcess[]` — read `/proc` from `hostRoot`/proc, filter kernel threads, skip claimed PIDs. |
| `agent/src/collectors/processes/dockerTop.ts` | `viaDockerTop(docker, containers): Map<pid, ObservedProcess>` — `docker top <id> -eo …` per container, parallel, 2s timeout. |
| `agent/src/collectors/processes/crictl.ts` | `viaCrictl(opts): Map<pid, ObservedProcess>` — root pid via `crictl inspect`, descendants via `/proc/<pid>/task/*/children`. |
| `agent/src/collectors/processes/poller.ts` | `runPollCycle(state, deps): { spawns, exits, argvDefs }` — pure orchestration of one cycle: collect → attribute → diff. Stateful via passed-in `state` object. |
| `agent/src/collectors/processes/index.ts` | `startProcessCollector(deps)` — `setInterval` loop, overrun-skip, MQTT publish, ring-buffer backpressure. Entry point wired from `agent/src/index.ts`. |
| `tests/unit/process-events-types.test.ts` | Shared-type smoke test. |
| `tests/unit/ingest-process-events.test.ts` | Hub ingest tests (argv upsert, spawn idempotency, exit update, orphan exit, double exit, oversize reject). |
| `tests/unit/processes-prune.test.ts` | Retention prune behaviour. |
| `tests/unit/processes-mqtt-dispatch.test.ts` | Hub MQTT topic routing → handler. |
| `tests/unit/agent-argv-hash.test.ts` | Hash determinism, pre-truncation, separator behaviour. |
| `tests/unit/agent-proc-walk.test.ts` | `/proc` fixture parse, kthread filter, claimed skip, NUL cmdline. |
| `tests/unit/agent-docker-top.test.ts` | Stdout parse, per-container timeout, parallel exec. |
| `tests/unit/agent-crictl.test.ts` | Runtime gating, binary-missing fallback, descendant walk. |
| `tests/unit/agent-process-poller.test.ts` | Cycle diff, attribution priority, argv-dict dedup, overrun skip, PID reuse. |
| `tests/unit/agent-process-mqtt-buffer.test.ts` | Ring buffer eviction, replay on reconnect. |
| `tests/unit/agent-process-config.test.ts` | Env overrides, defaults. |
| `tests/integration/process-events-e2e.test.ts` | End-to-end: spawn `bash` loop in test container, assert hub rows. |

### Modified files

| Path | Change |
|---|---|
| `hub/src/db/schema.ts` | `SCHEMA_VERSION 52 → 53`, add `CREATE TABLE` for `argv_dictionary` + `process_events` in bootstrap, add `if (fromVersion < 53)` migrate block, extend `pruneOldData` with process-events prune. |
| `hub/src/mqtt.ts` | Subscribe to `insightd/+/process_events` (QoS 0), route handler. |
| `hub/src/scheduler.ts` | No change needed — existing `pruneOldData` cron at 03:30 picks up the extension. |
| `agent/src/config.ts` | Add `processCollection` config block with env overrides. |
| `agent/src/index.ts` | Invoke `startProcessCollector` after MQTT client established. |
| `Dockerfile` (agent build stage) | `apk add crictl` (or curl pinned release). |
| `CLAUDE.md` | Update "Schema v33" line to current version. |

---

## Task 1: Shared types

**Files:**
- Create: `shared/types/process-events.ts`
- Create: `src/types/process-events.ts` (mirror)
- Test: `tests/unit/process-events-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/process-events-types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArgvDef, SpawnEvent, ExitEvent, ProcessEventPayload,
} from '../../shared/types/process-events';

describe('process-events shared types', () => {
  it('ArgvDef has hash + argv + comm', () => {
    const def: ArgvDef = { argv_hash: 'abc123', argv: '/bin/ls', comm: 'ls' };
    assert.equal(def.argv_hash, 'abc123');
  });

  it('SpawnEvent allows optional container_id and pod_uid', () => {
    const ev: SpawnEvent = {
      pid: 1, ppid: 0, argv_hash: 'x',
      started_at: '2026-05-12T00:00:00Z',
      source: 'host',
    };
    assert.equal(ev.container_id, undefined);
    assert.equal(ev.pod_uid, undefined);
  });

  it('ExitEvent permits null exit_code', () => {
    const ev: ExitEvent = {
      pid: 1, started_at: 's', exited_at: 'e', exit_code: null, lifetime_ms: 100,
    };
    assert.equal(ev.exit_code, null);
  });

  it('ProcessEventPayload exposes argv_defs, spawns, exits', () => {
    const p: ProcessEventPayload = { cycle_at: 'now', argv_defs: [], spawns: [], exits: [] };
    assert.deepEqual(p.spawns, []);
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/process-events-types.test.ts`
Expected: FAIL with `Cannot find module '../../shared/types/process-events'`.

- [ ] **Step 3: Write the types**

```typescript
// shared/types/process-events.ts
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
  exit_code: number | null;
  lifetime_ms: number;
}

export interface ProcessEventPayload {
  cycle_at: string;
  argv_defs: ArgvDef[];
  spawns: SpawnEvent[];
  exits: ExitEvent[];
}
```

- [ ] **Step 4: Mirror to `src/types/process-events.ts`**

Identical content. Top-level `src/` is the standalone-mode mirror of hub code.

```bash
cp shared/types/process-events.ts src/types/process-events.ts
```

(If the target dir does not yet exist: `mkdir -p src/types`.)

- [ ] **Step 5: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/process-events-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add shared/types/process-events.ts src/types/process-events.ts tests/unit/process-events-types.test.ts
git commit -m "feat(types): add shared process-events wire types (#264)"
```

---

## Task 2: Schema v53 — argv_dictionary + process_events

**Files:**
- Modify: `hub/src/db/schema.ts` — bump SCHEMA_VERSION, add CREATE TABLE blocks in bootstrap, add migrate(53) branch
- Test: `tests/unit/processes-schema.test.ts` (new)

- [ ] **Step 1: Write the failing schema test**

```typescript
// tests/unit/processes-schema.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { bootstrap, SCHEMA_VERSION } = require('../../hub/src/db/schema');

describe('schema v53 — process_events tables', () => {
  it('bumps SCHEMA_VERSION to 53', () => {
    assert.equal(SCHEMA_VERSION, 53);
  });

  it('creates argv_dictionary and process_events on bootstrap', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r: any) => r.name);
    assert.ok(tables.includes('argv_dictionary'), 'argv_dictionary missing');
    assert.ok(tables.includes('process_events'), 'process_events missing');
  });

  it('process_events has UNIQUE (host_id, pid, started_at)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    // Insert dummy argv first (FK not enforced but harmless).
    db.prepare(
      `INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('h1','/bin/ls','ls')`
    ).run();
    const ins = db.prepare(`
      INSERT INTO process_events
        (host_id, container_id, pod_uid, pid, ppid, argv_hash, started_at, source)
      VALUES (?, NULL, NULL, ?, ?, ?, ?, 'host')
    `);
    ins.run('h', 100, 1, 'h1', '2026-05-12T00:00:00Z');
    assert.throws(() => ins.run('h', 100, 1, 'h1', '2026-05-12T00:00:00Z'),
      /UNIQUE constraint failed/);
  });

  it('migrates from version 52 (cold migrate)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`UPDATE meta SET value='52' WHERE key='schema_version'`).run();
    db.exec('DROP TABLE IF EXISTS argv_dictionary; DROP TABLE IF EXISTS process_events;');
    bootstrap(db);  // should re-create
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE name='process_events'`
    ).get();
    assert.ok(row, 'process_events not re-created by migrate');
    const ver = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as any;
    assert.equal(ver.value, '53');
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/processes-schema.test.ts`
Expected: FAIL (SCHEMA_VERSION still 52, tables not created).

- [ ] **Step 3: Bump version constant**

In `hub/src/db/schema.ts`, change line 4:

```typescript
const SCHEMA_VERSION = 53;
```

- [ ] **Step 4: Add CREATE TABLE blocks in bootstrap**

In `hub/src/db/schema.ts`, find the existing `db.exec(\`…\`)` block that contains `CREATE TABLE IF NOT EXISTS insights` (around line 556). Append the two new tables to that same exec block (so fresh installs get them):

```sql
    CREATE TABLE IF NOT EXISTS argv_dictionary (
      argv_hash   TEXT PRIMARY KEY,
      argv        TEXT NOT NULL,
      comm        TEXT NOT NULL,
      first_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS process_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id       TEXT NOT NULL,
      container_id  TEXT,
      pod_uid       TEXT,
      pid           INTEGER NOT NULL,
      ppid          INTEGER NOT NULL,
      argv_hash     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      exited_at     TEXT,
      exit_code     INTEGER,
      lifetime_ms   INTEGER,
      source        TEXT NOT NULL,
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

- [ ] **Step 5: Add migrate branch for fromVersion < 53**

Find the end of the existing migrate function (just before the closing `}`). Append:

```typescript
  if (fromVersion < 53) {
    // process visibility — see spec docs/superpowers/specs/2026-05-12-per-container-process-visibility-design.md
    db.exec(`
      CREATE TABLE IF NOT EXISTS argv_dictionary (
        argv_hash   TEXT PRIMARY KEY,
        argv        TEXT NOT NULL,
        comm        TEXT NOT NULL,
        first_seen  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS process_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id       TEXT NOT NULL,
        container_id  TEXT,
        pod_uid       TEXT,
        pid           INTEGER NOT NULL,
        ppid          INTEGER NOT NULL,
        argv_hash     TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        exited_at     TEXT,
        exit_code     INTEGER,
        lifetime_ms   INTEGER,
        source        TEXT NOT NULL,
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
    `);
  }
```

- [ ] **Step 6: Mirror schema changes into `src/db/schema.ts`** (standalone mode)

Apply the SAME bump + bootstrap block + migrate branch to `src/db/schema.ts`. (If the file does not have an existing `SCHEMA_VERSION` constant, skip the bump and only add bootstrap CREATE TABLE blocks. Repo convention is that `src/` mirrors `hub/` minus MQTT pieces.)

- [ ] **Step 7: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/processes-schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Run full suite for regressions**

Run: `npm test`
Expected: no new failures introduced by schema bump.

- [ ] **Step 9: Commit**

```bash
git add hub/src/db/schema.ts src/db/schema.ts tests/unit/processes-schema.test.ts
git commit -m "feat(db): schema v53 — argv_dictionary + process_events (#264)"
```

---

## Task 3: Hub ingest module

**Files:**
- Create: `hub/src/ingest-process-events.ts`
- Test: `tests/unit/ingest-process-events.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ingest-process-events.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
const { ingestProcessEvents, MAX_EVENTS_PER_MESSAGE } =
  require('../../hub/src/ingest-process-events');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

describe('ingestProcessEvents', () => {
  it('upserts argv_dictionary entries (INSERT OR IGNORE)', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [
        { argv_hash: 'a', argv: '/bin/ls -la', comm: 'ls' },
        { argv_hash: 'a', argv: '/bin/ls -la', comm: 'ls' },
      ],
      spawns: [], exits: [],
    });
    const rows = db.prepare('SELECT * FROM argv_dictionary').all();
    assert.equal(rows.length, 1);
  });

  it('inserts spawn rows; duplicate is no-op via UNIQUE constraint', () => {
    const db = freshDb();
    const spawn = {
      pid: 100, ppid: 1, argv_hash: 'h',
      started_at: '2026-05-12T00:00:00Z', source: 'host' as const,
    };
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now', argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [spawn], exits: [],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now2', argv_defs: [], spawns: [spawn], exits: [],
    });
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 1);
  });

  it('applies exit: fills exited_at, exit_code, lifetime_ms', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [], spawns: [],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: '2026-05-12T00:00:05Z', exit_code: 0, lifetime_ms: 5000,
      }],
    });
    const row = db.prepare(
      'SELECT exited_at, exit_code, lifetime_ms FROM process_events WHERE pid=100'
    ).get() as any;
    assert.equal(row.exited_at, '2026-05-12T00:00:05Z');
    assert.equal(row.exit_code, 0);
    assert.equal(row.lifetime_ms, 5000);
  });

  it('orphan exit (no prior spawn) is a no-op', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now', argv_defs: [], spawns: [],
      exits: [{
        pid: 999, started_at: '2026-05-12T00:00:00Z',
        exited_at: '2026-05-12T00:00:01Z', exit_code: null, lifetime_ms: 1000,
      }],
    });
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 0);
  });

  it('double exit does not overwrite previously-set exit_code', () => {
    const db = freshDb();
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/x', comm: 'x' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: 'E1', exit_code: 0, lifetime_ms: 1000,
      }],
    });
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now2', argv_defs: [], spawns: [],
      exits: [{
        pid: 100, started_at: '2026-05-12T00:00:00Z',
        exited_at: 'E2', exit_code: 99, lifetime_ms: 9999,
      }],
    });
    const row = db.prepare(
      'SELECT exited_at, exit_code FROM process_events WHERE pid=100'
    ).get() as any;
    assert.equal(row.exited_at, 'E1');     // first exit wins
    assert.equal(row.exit_code, 0);
  });

  it('rejects oversize messages', () => {
    const db = freshDb();
    const spawns = Array.from({ length: MAX_EVENTS_PER_MESSAGE + 1 }, (_, i) => ({
      pid: i + 1, ppid: 1, argv_hash: 'h',
      started_at: '2026-05-12T00:00:00Z', source: 'host' as const,
    }));
    assert.throws(
      () => ingestProcessEvents(db, 'h1',
        { cycle_at: 'now', argv_defs: [], spawns, exits: [] }),
      /oversize/i
    );
    const count = db.prepare('SELECT COUNT(*) AS c FROM process_events').get() as any;
    assert.equal(count.c, 0, 'no partial ingest');
  });

  it('truncates argv text to 4096 bytes on insert', () => {
    const db = freshDb();
    const long = 'x'.repeat(8000);
    ingestProcessEvents(db, 'h1', {
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: long, comm: 'x' }],
      spawns: [], exits: [],
    });
    const row = db.prepare('SELECT argv FROM argv_dictionary').get() as any;
    assert.equal(row.argv.length, 4096);
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/ingest-process-events.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module**

```typescript
// hub/src/ingest-process-events.ts
import type Database from 'better-sqlite3';
import type { ProcessEventPayload } from '../../shared/types/process-events';
import logger = require('../../shared/utils/logger');

export const MAX_EVENTS_PER_MESSAGE = 10000;
const ARGV_MAX_BYTES = 4096;

export function ingestProcessEvents(
  db: Database.Database,
  hostId: string,
  payload: ProcessEventPayload,
): void {
  const total =
    (payload.argv_defs?.length ?? 0) +
    (payload.spawns?.length ?? 0) +
    (payload.exits?.length ?? 0);
  if (total > MAX_EVENTS_PER_MESSAGE) {
    throw new Error(`oversize process_events payload (${total} > ${MAX_EVENTS_PER_MESSAGE})`);
  }

  const argvIns = db.prepare(
    `INSERT OR IGNORE INTO argv_dictionary (argv_hash, argv, comm) VALUES (?, ?, ?)`
  );
  const spawnIns = db.prepare(`
    INSERT OR IGNORE INTO process_events
      (host_id, container_id, pod_uid, pid, ppid, argv_hash, started_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const exitUpd = db.prepare(`
    UPDATE process_events
       SET exited_at = ?, exit_code = ?, lifetime_ms = ?
     WHERE host_id = ? AND pid = ? AND started_at = ? AND exited_at IS NULL
  `);

  const tx = db.transaction(() => {
    for (const def of payload.argv_defs ?? []) {
      argvIns.run(def.argv_hash, def.argv.slice(0, ARGV_MAX_BYTES), def.comm);
    }
    for (const s of payload.spawns ?? []) {
      spawnIns.run(
        hostId, s.container_id ?? null, s.pod_uid ?? null,
        s.pid, s.ppid, s.argv_hash, s.started_at, s.source,
      );
    }
    for (const e of payload.exits ?? []) {
      exitUpd.run(
        e.exited_at, e.exit_code ?? null, e.lifetime_ms,
        hostId, e.pid, e.started_at,
      );
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('ingest-process-events',
      `tx failed host=${hostId}: ${(err as Error).message}`);
    throw err;
  }
}
```

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/ingest-process-events.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/src/ingest-process-events.ts tests/unit/ingest-process-events.test.ts
git commit -m "feat(hub): process-events ingest (#264)"
```

---

## Task 4: Retention prune

**Files:**
- Modify: `hub/src/db/schema.ts` — extend `pruneOldData`
- Test: `tests/unit/processes-prune.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/processes-prune.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap, pruneOldData } = require('../../hub/src/db/schema');

describe('process-events retention', () => {
  it('deletes process_events older than 7 days', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('h','/x','x')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 1, 0, 'h', datetime('now', '-8 days'), 'host')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 2, 0, 'h', datetime('now', '-1 day'), 'host')`).run();
    pruneOldData(db);
    const rows = db.prepare(`SELECT pid FROM process_events ORDER BY pid`).all();
    assert.deepEqual(rows, [{ pid: 2 }]);
  });

  it('GCs argv_dictionary rows not referenced by process_events', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm) VALUES ('keep','/k','k'),('drop','/d','d')`).run();
    db.prepare(`INSERT INTO process_events
       (host_id, pid, ppid, argv_hash, started_at, source)
       VALUES ('h1', 1, 0, 'keep', datetime('now'), 'host')`).run();
    pruneOldData(db);
    const hashes = db.prepare(`SELECT argv_hash FROM argv_dictionary ORDER BY argv_hash`).all();
    assert.deepEqual(hashes, [{ argv_hash: 'keep' }]);
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/processes-prune.test.ts`
Expected: FAIL — prune does not touch new tables.

- [ ] **Step 3: Extend `pruneOldData`**

In `hub/src/db/schema.ts`, locate the existing `pruneOldData` function. Just before its closing brace, append:

```typescript
  // Process events (independent 7d retention; see spec 2026-05-12-per-container-process-visibility-design.md)
  const rPe = db.prepare(
    `DELETE FROM process_events WHERE started_at < datetime('now', '-7 days')`
  ).run();
  const rAd = db.prepare(
    `DELETE FROM argv_dictionary
      WHERE argv_hash NOT IN (SELECT DISTINCT argv_hash FROM process_events)`
  ).run();
  logger.info('schema',
    `Pruned ${rPe.changes} process_events rows, ${rAd.changes} orphaned argv entries`);
```

(`logger` is already imported at the top of `schema.ts`.)

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/processes-prune.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/src/db/schema.ts tests/unit/processes-prune.test.ts
git commit -m "feat(hub): retention prune for process_events (#264)"
```

---

## Task 5: MQTT dispatch wiring

**Files:**
- Modify: `hub/src/mqtt.ts` — subscribe to topic, route handler
- Test: `tests/unit/processes-mqtt-dispatch.test.ts` (new)

- [ ] **Step 1: Inspect existing dispatch shape**

Read the `client.on('message', …)` handler in `hub/src/mqtt.ts` and identify the topic-parsing switch. Topics follow `insightd/<host_id>/<kind>`. The handler extracts `kind` and dispatches.

- [ ] **Step 2: Write the failing test**

This test exercises only the dispatch logic, not real MQTT. Extract `dispatchMessage` (or whatever the internal switch is named) — if it's inline inside `setupMqtt`, the test should call `setupMqtt` with a stub client. Easiest path: introduce an exported `handleMqttMessage(db, topic, payload)` function and have `setupMqtt` use it.

```typescript
// tests/unit/processes-mqtt-dispatch.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const { bootstrap } = require('../../hub/src/db/schema');
const { handleMqttMessage } = require('../../hub/src/mqtt');

describe('mqtt process_events dispatch', () => {
  it('routes insightd/<host>/process_events into ingest-process-events', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);

    const payload = Buffer.from(JSON.stringify({
      cycle_at: 'now',
      argv_defs: [{ argv_hash: 'h', argv: '/bin/ls', comm: 'ls' }],
      spawns: [{
        pid: 100, ppid: 1, argv_hash: 'h',
        started_at: '2026-05-12T00:00:00Z', source: 'host',
      }],
      exits: [],
    }));

    handleMqttMessage(db, 'insightd/host-A/process_events', payload);

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM process_events WHERE host_id='host-A'`
    ).get() as any;
    assert.equal(count.c, 1);
  });

  it('ignores unknown topics without throwing', () => {
    const db = new Database(':memory:');
    bootstrap(db);
    assert.doesNotThrow(() =>
      handleMqttMessage(db, 'insightd/host-A/unknown_kind', Buffer.from('{}')));
  });
});
```

- [ ] **Step 3: Run the test, see it fail**

Run: `npx tsx --test tests/unit/processes-mqtt-dispatch.test.ts`
Expected: FAIL — `handleMqttMessage` not exported.

- [ ] **Step 4: Refactor inline dispatch into exported function (if not already)**

If `hub/src/mqtt.ts` already inlines dispatch in `client.on('message', (topic, msg) => { ... })`, lift the switch body into:

```typescript
export function handleMqttMessage(
  db: Database.Database,
  topic: string,
  payload: Buffer,
): void {
  // existing topic parsing + dispatch ...
}
```

…and replace the inline handler with `handleMqttMessage(db, topic, payload)`.

Within the dispatch, add the new case (after existing topic kinds; the parser already pulls `kind` from `parts[2]`):

```typescript
  if (kind === 'process_events') {
    const { ingestProcessEvents } =
      require('./ingest-process-events') as {
        ingestProcessEvents: (db: Database.Database, hostId: string, p: any) => void;
      };
    try {
      const parsed = JSON.parse(payload.toString());
      ingestProcessEvents(db, hostId, parsed);
    } catch (err) {
      logger.error('mqtt', `process_events ingest failed: ${(err as Error).message}`);
    }
    return;
  }
```

- [ ] **Step 5: Subscribe to the topic alongside the others**

Add a subscribe call next to the existing ones near line 209:

```typescript
client!.subscribe('insightd/+/process_events', { qos: 0 }, (err) => {
  if (err) logger.error('mqtt', 'Failed to subscribe to process_events topic');
});
```

QoS 0 because the agent emits at 5s cadence and replay tolerance is the design's job, not the broker's. The cost-of-loss is small (one cycle gap).

- [ ] **Step 6: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/processes-mqtt-dispatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run full hub tests for regressions**

Run: `npm test`
Expected: existing MQTT tests still green; the dispatch refactor must not change behaviour for any other topic.

- [ ] **Step 8: Commit**

```bash
git add hub/src/mqtt.ts tests/unit/processes-mqtt-dispatch.test.ts
git commit -m "feat(hub): subscribe + dispatch insightd/+/process_events (#264)"
```

---

## Task 6: Agent argv hashing util

**Files:**
- Create: `agent/src/collectors/processes/argvHash.ts`
- Test: `tests/unit/agent-argv-hash.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/agent-argv-hash.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { hashArgv, joinArgv } =
  require('../../agent/src/collectors/processes/argvHash');

describe('hashArgv', () => {
  it('returns 16 hex chars', () => {
    const h = hashArgv(['/bin/ls', '-la']);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    const a = hashArgv(['/bin/ls', '-la']);
    const b = hashArgv(['/bin/ls', '-la']);
    assert.equal(a, b);
  });

  it('distinguishes different argv', () => {
    assert.notEqual(hashArgv(['ls']), hashArgv(['ls', '-la']));
  });

  it('hashes pre-truncation (full string)', () => {
    const short = ['x', 'a'.repeat(5000)];
    const longer = ['x', 'a'.repeat(6000)];
    assert.notEqual(hashArgv(short), hashArgv(longer),
      'hash must use full argv, not truncated form');
  });

  it('joinArgv uses single space separator and preserves args', () => {
    assert.equal(joinArgv(['a', 'b', 'c']), 'a b c');
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-argv-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// agent/src/collectors/processes/argvHash.ts
import { createHash } from 'crypto';

export function joinArgv(argv: string[]): string {
  return argv.join(' ');
}

export function hashArgv(argv: string[]): string {
  return createHash('sha256').update(joinArgv(argv)).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-argv-hash.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/collectors/processes/argvHash.ts tests/unit/agent-argv-hash.test.ts
git commit -m "feat(agent): argv hashing util (#264)"
```

---

## Task 7: Agent `/proc` walker

**Files:**
- Create: `agent/src/collectors/processes/procWalk.ts`
- Test: `tests/unit/agent-proc-walk.test.ts`

- [ ] **Step 1: Sketch the interface**

```typescript
export interface ObservedProcess {
  pid: number;
  ppid: number;
  comm: string;
  argv: string;           // space-joined, post-truncation (4096B)
  argvFull: string[];     // full argv array; passed to hashArgv
  argvHash: string;
  startedAt: string;      // ISO-8601 UTC
  source: 'docker' | 'k8s' | 'host';
  containerId?: string;
  podUid?: string;
}

export interface ProcWalkOpts {
  procRoot: string;             // e.g. '/host/proc' or test fixture
  bootTimeMs: number;           // ms since epoch when the kernel booted
  claimedPids: Set<number>;     // skip these
  argvMaxBytes: number;
}

export function walkProc(opts: ProcWalkOpts): ObservedProcess[];
```

The `bootTimeMs` is read once at agent startup from `/proc/uptime`. `startedAt` for each process derives from `/proc/<pid>/stat` field 22 (jiffies since boot) divided by `sysconf(_SC_CLK_TCK)` (typically 100) and added to `bootTimeMs`.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/agent-proc-walk.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { walkProc } = require('../../agent/src/collectors/processes/procWalk');

let tmpProc: string;

function makeProc(pid: number, opts: {
  ppid: number; comm: string; cmdline: string[]; kthread?: boolean;
  starttimeJiffies?: number;
}) {
  const dir = path.join(tmpProc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  // /proc/<pid>/stat — 52 fields. We need only fields 1-22.
  // Field 3 = state (R/S/Z/...); field 4 = ppid; field 9 = flags;
  // PF_KTHREAD = 0x00200000; field 22 = starttime jiffies.
  const flags = opts.kthread ? 0x00200000 : 0;
  const fields = [
    pid, `(${opts.comm})`, 'S', opts.ppid, 0, 0, 0, 0, flags,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, opts.starttimeJiffies ?? 1000,
  ];
  // Pad to 52 fields with zeros.
  while (fields.length < 52) fields.push(0);
  fs.writeFileSync(path.join(dir, 'stat'), fields.join(' '));
  fs.writeFileSync(path.join(dir, 'cmdline'), opts.cmdline.join('\0') + '\0');
}

describe('walkProc', () => {
  before(() => {
    tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'procwalk-'));
    makeProc(100, { ppid: 1, comm: 'sshd', cmdline: ['/usr/sbin/sshd', '-D'] });
    makeProc(101, { ppid: 100, comm: 'bash', cmdline: ['bash'] });
    makeProc(2, { ppid: 0, comm: 'kthreadd', cmdline: [], kthread: true });
    // Garbage non-pid entries the walker should ignore
    fs.mkdirSync(path.join(tmpProc, 'self'));
    fs.writeFileSync(path.join(tmpProc, 'uptime'), '1.0 1.0\n');
  });
  after(() => fs.rmSync(tmpProc, { recursive: true, force: true }));

  it('returns non-kthread processes only', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const pids = procs.map(p => p.pid).sort((a, b) => a - b);
    assert.deepEqual(pids, [100, 101]);
  });

  it('skips claimed PIDs', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set([101]), argvMaxBytes: 4096,
    });
    assert.deepEqual(procs.map(p => p.pid), [100]);
  });

  it('parses cmdline with NUL separators into argv array', () => {
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const sshd = procs.find(p => p.pid === 100)!;
    assert.deepEqual(sshd.argvFull, ['/usr/sbin/sshd', '-D']);
    assert.equal(sshd.argv, '/usr/sbin/sshd -D');
  });

  it('truncates argv string to argvMaxBytes, but hash uses full argv', () => {
    const longArgv = ['x', 'a'.repeat(8000)];
    makeProc(200, { ppid: 1, comm: 'big', cmdline: longArgv });
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    const big = procs.find(p => p.pid === 200)!;
    assert.equal(big.argv.length, 4096);
    assert.equal(big.argvFull[1].length, 8000);
  });

  it('omits processes with empty cmdline (kthread or race)', () => {
    makeProc(300, { ppid: 1, comm: 'empty', cmdline: [] });
    const procs = walkProc({
      procRoot: tmpProc, bootTimeMs: 0,
      claimedPids: new Set(), argvMaxBytes: 4096,
    });
    assert.equal(procs.find(p => p.pid === 300), undefined);
  });
});
```

- [ ] **Step 3: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-proc-walk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```typescript
// agent/src/collectors/processes/procWalk.ts
import * as fs from 'fs';
import * as path from 'path';
import { hashArgv, joinArgv } from './argvHash';

const PF_KTHREAD = 0x00200000;
const CLK_TCK = 100;  // sysconf(_SC_CLK_TCK) is 100 on all Linux distros agent runs on

export interface ObservedProcess {
  pid: number;
  ppid: number;
  comm: string;
  argv: string;
  argvFull: string[];
  argvHash: string;
  startedAt: string;
  source: 'docker' | 'k8s' | 'host';
  containerId?: string;
  podUid?: string;
}

export interface ProcWalkOpts {
  procRoot: string;
  bootTimeMs: number;
  claimedPids: Set<number>;
  argvMaxBytes: number;
}

function parseStat(content: string): { ppid: number; flags: number; starttime: number; comm: string } | null {
  // The comm field is (parens-wrapped) and may contain spaces.
  // Strategy: take everything between the first '(' and last ')'.
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const comm = content.slice(open + 1, close);
  const rest = content.slice(close + 2).split(' ');
  // After comm, fields are state(1) ppid(2) ... → rest[0]=state, rest[1]=ppid, ...
  // Field 9 (flags) is rest[6]; field 22 (starttime) is rest[19].
  const ppid = parseInt(rest[1], 10);
  const flags = parseInt(rest[6], 10);
  const starttime = parseInt(rest[19], 10);
  if (Number.isNaN(ppid) || Number.isNaN(flags) || Number.isNaN(starttime)) return null;
  return { ppid, flags, starttime, comm };
}

function readArgv(procRoot: string, pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    if (!raw) return null;
    // NUL-separated, often trailing NUL.
    const parts = raw.split('\0').filter(s => s.length > 0);
    if (parts.length === 0) return null;
    return parts;
  } catch {
    return null;
  }
}

export function walkProc(opts: ProcWalkOpts): ObservedProcess[] {
  const out: ObservedProcess[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(opts.procRoot);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = parseInt(name, 10);
    if (opts.claimedPids.has(pid)) continue;

    let stat: ReturnType<typeof parseStat>;
    try {
      stat = parseStat(fs.readFileSync(path.join(opts.procRoot, name, 'stat'), 'utf8'));
    } catch {
      continue;
    }
    if (!stat) continue;
    if (stat.flags & PF_KTHREAD) continue;

    const argvFull = readArgv(opts.procRoot, pid);
    if (!argvFull) continue;

    const joined = joinArgv(argvFull);
    const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
    const argvHash = hashArgv(argvFull);
    const startedAtMs = opts.bootTimeMs + (stat.starttime / CLK_TCK) * 1000;
    out.push({
      pid,
      ppid: stat.ppid,
      comm: stat.comm,
      argv,
      argvFull,
      argvHash,
      startedAt: new Date(startedAtMs).toISOString(),
      source: 'host',
    });
  }
  return out;
}
```

- [ ] **Step 5: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-proc-walk.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add agent/src/collectors/processes/procWalk.ts tests/unit/agent-proc-walk.test.ts
git commit -m "feat(agent): /proc walker with kthread filter (#264)"
```

---

## Task 8: Agent `docker top` adapter

**Files:**
- Create: `agent/src/collectors/processes/dockerTop.ts`
- Test: `tests/unit/agent-docker-top.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/agent-docker-top.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { parseDockerTop, viaDockerTop } =
  require('../../agent/src/collectors/processes/dockerTop');

describe('parseDockerTop', () => {
  it('parses dockerode Top() output', () => {
    const dockerodeOut = {
      Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
      Processes: [
        ['100', '1', 'nginx', 'nginx: master process /usr/sbin/nginx'],
        ['101', '100', 'nginx', 'nginx: worker process'],
      ],
    };
    const procs = parseDockerTop(dockerodeOut);
    assert.equal(procs.length, 2);
    assert.equal(procs[0].pid, 100);
    assert.equal(procs[0].ppid, 1);
    assert.deepEqual(procs[0].argvFull,
      ['nginx:', 'master', 'process', '/usr/sbin/nginx']);
  });

  it('returns [] when Processes is missing or empty', () => {
    assert.deepEqual(parseDockerTop({ Titles: [], Processes: null }), []);
    assert.deepEqual(parseDockerTop({ Titles: [], Processes: [] }), []);
  });
});

describe('viaDockerTop', () => {
  it('aggregates per-container with timeout, container source wins', async () => {
    const stub = {
      getContainer(id: string) {
        return {
          top: async () => ({
            Titles: ['PID', 'PPID', 'COMM', 'ARGS'],
            Processes: [[String(parseInt(id) + 100), '1', 'x', '/bin/x']],
          }),
        };
      },
    };
    const map = await viaDockerTop(stub, [
      { Id: '1', Names: ['/a'] },
      { Id: '2', Names: ['/b'] },
    ], { timeoutMs: 1000, bootTimeMs: 0, argvMaxBytes: 4096 });
    assert.equal(map.size, 2);
    const pid101 = map.get(101)!;
    assert.equal(pid101.source, 'docker');
    assert.equal(pid101.containerId, '1');
  });

  it('skips containers whose top() exceeds timeout', async () => {
    const stub = {
      getContainer(id: string) {
        return {
          top: () => new Promise(resolve =>
            setTimeout(() => resolve({ Titles: [], Processes: [] }), id === '1' ? 50 : 10000)
          ),
        };
      },
    };
    const map = await viaDockerTop(stub, [
      { Id: '1', Names: ['/fast'] },
      { Id: '2', Names: ['/slow'] },
    ], { timeoutMs: 200, bootTimeMs: 0, argvMaxBytes: 4096 });
    // Fast resolved (with no procs). Slow timed out → no entries for container 2.
    const sources = Array.from(map.values()).map(p => p.containerId);
    assert.ok(!sources.includes('2'));
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-docker-top.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// agent/src/collectors/processes/dockerTop.ts
import { hashArgv, joinArgv } from './argvHash';
import type { ObservedProcess } from './procWalk';
import logger = require('../../../shared/utils/logger');

interface DockerTopResult {
  Titles?: string[] | null;
  Processes?: string[][] | null;
}

export function parseDockerTop(res: DockerTopResult): {
  pid: number; ppid: number; comm: string; argvFull: string[];
}[] {
  if (!res.Processes || res.Processes.length === 0) return [];
  const titles = (res.Titles ?? []).map(t => t.toUpperCase());
  const pidIdx = titles.indexOf('PID');
  const ppidIdx = titles.indexOf('PPID');
  const commIdx = titles.indexOf('COMM');
  const argsIdx = titles.indexOf('ARGS');
  if (pidIdx < 0 || ppidIdx < 0 || argsIdx < 0) return [];
  const out = [];
  for (const row of res.Processes) {
    const pid = parseInt(row[pidIdx], 10);
    const ppid = parseInt(row[ppidIdx], 10);
    const comm = commIdx >= 0 ? row[commIdx] : '';
    const argvFull = row[argsIdx].split(/\s+/).filter(s => s.length > 0);
    if (Number.isNaN(pid) || argvFull.length === 0) continue;
    out.push({ pid, ppid, comm, argvFull });
  }
  return out;
}

export interface DockerTopOpts {
  timeoutMs: number;
  bootTimeMs: number;            // currently unused; reserved for future startedAt derivation
  argvMaxBytes: number;
}

export async function viaDockerTop(
  docker: any,                   // dockerode-like; minimal surface = getContainer(id).top()
  containers: Array<{ Id: string; Names: string[] }>,
  opts: DockerTopOpts,
): Promise<Map<number, ObservedProcess>> {
  const now = new Date().toISOString();   // startedAt unknown via docker top; use observation time

  const results = await Promise.allSettled(containers.map(c => {
    const inst = docker.getContainer(c.Id);
    return Promise.race([
      inst.top().then((r: DockerTopResult) => ({ c, r })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`docker top timeout for ${c.Id}`)), opts.timeoutMs),
      ),
    ]);
  }));

  const map = new Map<number, ObservedProcess>();
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('processes', String((r.reason as Error)?.message ?? r.reason));
      continue;
    }
    const { c, r: top } = r.value as any;
    for (const proc of parseDockerTop(top)) {
      const joined = joinArgv(proc.argvFull);
      const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
      map.set(proc.pid, {
        pid: proc.pid,
        ppid: proc.ppid,
        comm: proc.comm,
        argv,
        argvFull: proc.argvFull,
        argvHash: hashArgv(proc.argvFull),
        startedAt: now,           // approximation; finer attribution arrives once /proc is checked
        source: 'docker',
        containerId: c.Id,
      });
    }
  }
  return map;
}
```

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-docker-top.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/collectors/processes/dockerTop.ts tests/unit/agent-docker-top.test.ts
git commit -m "feat(agent): docker top adapter for process visibility (#264)"
```

---

## Task 9: Agent crictl adapter

**Files:**
- Create: `agent/src/collectors/processes/crictl.ts`
- Test: `tests/unit/agent-crictl.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/agent-crictl.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { viaCrictl, isCrictlAvailable } =
  require('../../agent/src/collectors/processes/crictl');

describe('viaCrictl', () => {
  it('returns empty map when runtime is not k8s', async () => {
    const m = await viaCrictl({ runtime: 'docker' } as any);
    assert.equal(m.size, 0);
  });

  it('returns empty map when binary unavailable, logs once', async () => {
    const m = await viaCrictl({
      runtime: 'kubernetes',
      crictlAvailable: false,
      bootTimeMs: 0, argvMaxBytes: 4096,
    } as any);
    assert.equal(m.size, 0);
  });

  it('isCrictlAvailable returns true when which() resolves', async () => {
    const v = await isCrictlAvailable({ whichSync: () => '/usr/bin/crictl' });
    assert.equal(v, true);
  });

  it('isCrictlAvailable returns false when which() throws', async () => {
    const v = await isCrictlAvailable({ whichSync: () => { throw new Error('not found'); } });
    assert.equal(v, false);
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-crictl.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (skeleton sufficient for v1 — runtime gating + missing-binary fallback only)**

The crictl integration is intentionally minimal in v1. Real per-pod process walking via `crictl inspect <id>` plus `/proc/<rootpid>/task/*/children` is implemented but kept opt-in by the `crictlAvailable` flag. If the binary is missing, the agent falls back to host `/proc` walk only — pod attribution is then absent, which is acceptable for v1 and documented in the spec.

```typescript
// agent/src/collectors/processes/crictl.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { hashArgv, joinArgv } from './argvHash';
import type { ObservedProcess } from './procWalk';
import logger = require('../../../shared/utils/logger');

export interface CrictlOpts {
  runtime: 'docker' | 'kubernetes' | 'auto';
  crictlAvailable: boolean;
  procRoot: string;
  bootTimeMs: number;
  argvMaxBytes: number;
}

export async function isCrictlAvailable(deps?: { whichSync?: () => string }): Promise<boolean> {
  const which = deps?.whichSync ?? (() =>
    execFileSync('which', ['crictl'], { encoding: 'utf8' }).trim());
  try {
    const out = which();
    return out.length > 0;
  } catch {
    return false;
  }
}

interface CrictlPodSandbox { id: string; metadata?: { uid?: string } }

function listPods(): CrictlPodSandbox[] {
  try {
    const out = execFileSync('crictl', ['pods', '-o', 'json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return parsed.items ?? [];
  } catch (err) {
    logger.warn('processes', `crictl pods failed: ${(err as Error).message}`);
    return [];
  }
}

function inspectPodRootPid(podId: string): number | null {
  try {
    const out = execFileSync('crictl', ['inspectp', '-o', 'json', podId], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const pid = parsed?.info?.pid ?? parsed?.pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function readDescendantPids(procRoot: string, rootPid: number): number[] {
  const pids = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    const tasksDir = path.join(procRoot, String(p), 'task');
    let tasks: string[] = [];
    try { tasks = fs.readdirSync(tasksDir); } catch { continue; }
    for (const t of tasks) {
      const childrenFile = path.join(tasksDir, t, 'children');
      try {
        const raw = fs.readFileSync(childrenFile, 'utf8').trim();
        if (!raw) continue;
        for (const c of raw.split(/\s+/)) {
          const n = parseInt(c, 10);
          if (!Number.isNaN(n) && !pids.has(n)) {
            pids.add(n);
            queue.push(n);
          }
        }
      } catch { /* /proc race or perm; skip */ }
    }
  }
  return [...pids];
}

export async function viaCrictl(opts: CrictlOpts): Promise<Map<number, ObservedProcess>> {
  const map = new Map<number, ObservedProcess>();
  if (opts.runtime !== 'kubernetes') return map;
  if (!opts.crictlAvailable) return map;

  const pods = listPods();
  for (const pod of pods) {
    const rootPid = inspectPodRootPid(pod.id);
    if (rootPid === null) continue;
    const descendants = readDescendantPids(opts.procRoot, rootPid);
    for (const pid of descendants) {
      // Re-read /proc to populate the ObservedProcess.
      let argvFull: string[] | null = null;
      try {
        const raw = fs.readFileSync(path.join(opts.procRoot, String(pid), 'cmdline'), 'utf8');
        argvFull = raw.split('\0').filter(s => s.length > 0);
      } catch { continue; }
      if (!argvFull || argvFull.length === 0) continue;
      const joined = joinArgv(argvFull);
      const argv = joined.length > opts.argvMaxBytes ? joined.slice(0, opts.argvMaxBytes) : joined;
      map.set(pid, {
        pid,
        ppid: 0,    // not parsed here; consumers don't require ppid for k8s-source rows in v1
        comm: argvFull[0].split('/').pop() ?? '',
        argv,
        argvFull,
        argvHash: hashArgv(argvFull),
        startedAt: new Date().toISOString(),
        source: 'k8s',
        podUid: pod.metadata?.uid,
      });
    }
  }
  return map;
}
```

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-crictl.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/collectors/processes/crictl.ts tests/unit/agent-crictl.test.ts
git commit -m "feat(agent): crictl adapter with runtime gating (#264)"
```

---

## Task 10: Agent poller orchestrator (cycle diff + attribution)

**Files:**
- Create: `agent/src/collectors/processes/poller.ts`
- Test: `tests/unit/agent-process-poller.test.ts`

- [ ] **Step 1: Define the interface**

```typescript
export interface PollerDeps {
  collectDocker: () => Promise<Map<number, ObservedProcess>>;
  collectK8s:    () => Promise<Map<number, ObservedProcess>>;
  collectHost:   (claimed: Set<number>) => ObservedProcess[];
  now: () => Date;
}

export interface PollerState {
  prevKeyToProc: Map<string, ObservedProcess>;   // key = `${pid}:${startedAt}`
  shippedHashes: Set<string>;
}

export interface CycleResult {
  cycle_at: string;
  argv_defs: ArgvDef[];
  spawns: SpawnEvent[];
  exits: ExitEvent[];
}

export function makeKey(pid: number, startedAt: string): string;
export function newState(): PollerState;
export async function runPollCycle(state: PollerState, deps: PollerDeps): Promise<CycleResult>;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/agent-process-poller.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { runPollCycle, newState, makeKey } =
  require('../../agent/src/collectors/processes/poller');

function proc(p: Partial<any>): any {
  return {
    pid: 0, ppid: 1, argvHash: 'h', argvFull: ['/bin/x'], comm: 'x', argv: '/bin/x',
    startedAt: '2026-05-12T00:00:00Z', source: 'host', ...p,
  };
}

describe('poller cycle', () => {
  it('emits spawns for new keys, exits for vanished keys', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');

    const cycle1 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100 }), proc({ pid: 101, startedAt: 's1' })],
      now: () => now,
    });
    assert.equal(cycle1.spawns.length, 2);
    assert.equal(cycle1.exits.length, 0);

    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100 }), proc({ pid: 102 })],
      now: () => now,
    });
    assert.equal(cycle2.spawns.length, 1, 'only 102 is new');
    assert.equal(cycle2.spawns[0].pid, 102);
    assert.equal(cycle2.exits.length, 1, '101 vanished');
    assert.equal(cycle2.exits[0].pid, 101);
    assert.equal(cycle2.exits[0].lifetime_ms, 5000);
  });

  it('container source wins; host /proc gap-fills only unclaimed PIDs', async () => {
    const state = newState();
    let claimedSeen: Set<number> | null = null;
    const result = await runPollCycle(state, {
      collectDocker: async () => new Map([[100, proc({ pid: 100, source: 'docker', containerId: 'C' })]]),
      collectK8s:    async () => new Map(),
      collectHost:   (claimed: Set<number>) => {
        claimedSeen = claimed;
        return [proc({ pid: 200 })];  // host returns only unclaimed
      },
      now: () => new Date('2026-05-12T00:00:00Z'),
    });
    assert.deepEqual([...claimedSeen!].sort(), [100]);
    assert.equal(result.spawns.length, 2);
    const docker = result.spawns.find(s => s.pid === 100)!;
    assert.equal(docker.source, 'docker');
    assert.equal(docker.container_id, 'C');
    const host = result.spawns.find(s => s.pid === 200)!;
    assert.equal(host.source, 'host');
    assert.equal(host.container_id, undefined);
  });

  it('argv_defs include each hash only the first time it ships', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');
    const cycle1 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [
        proc({ pid: 100, argvHash: 'A' }),
        proc({ pid: 101, argvHash: 'A' }),
        proc({ pid: 102, argvHash: 'B' }),
      ],
      now: () => now,
    });
    assert.equal(cycle1.argv_defs.length, 2,
      'A and B each once');

    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [
        proc({ pid: 100, argvHash: 'A' }),
        proc({ pid: 103, argvHash: 'C' }),
      ],
      now: () => now,
    });
    assert.deepEqual(cycle2.argv_defs.map((d: any) => d.argv_hash).sort(), ['C']);
  });

  it('PID reuse with new startedAt is treated as new spawn', async () => {
    const state = newState();
    let now = new Date('2026-05-12T00:00:00Z');
    await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100, startedAt: 's1' })],
      now: () => now,
    });
    now = new Date('2026-05-12T00:00:05Z');
    const cycle2 = await runPollCycle(state, {
      collectDocker: async () => new Map(),
      collectK8s:    async () => new Map(),
      collectHost:   () => [proc({ pid: 100, startedAt: 's2' })],
      now: () => now,
    });
    // s1 vanished → exit. s2 new → spawn.
    assert.equal(cycle2.spawns.length, 1);
    assert.equal(cycle2.exits.length, 1);
    assert.equal(cycle2.exits[0].started_at, 's1');
  });
});
```

- [ ] **Step 3: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-process-poller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```typescript
// agent/src/collectors/processes/poller.ts
import type { ObservedProcess } from './procWalk';
import type {
  ArgvDef, SpawnEvent, ExitEvent, ProcessEventPayload,
} from '../../../../shared/types/process-events';

export interface PollerDeps {
  collectDocker: () => Promise<Map<number, ObservedProcess>>;
  collectK8s:    () => Promise<Map<number, ObservedProcess>>;
  collectHost:   (claimed: Set<number>) => ObservedProcess[];
  now: () => Date;
}

export interface PollerState {
  prevKeyToProc: Map<string, ObservedProcess>;
  shippedHashes: Set<string>;
}

export function newState(): PollerState {
  return { prevKeyToProc: new Map(), shippedHashes: new Set() };
}

export function makeKey(pid: number, startedAt: string): string {
  return `${pid}:${startedAt}`;
}

export async function runPollCycle(
  state: PollerState,
  deps: PollerDeps,
): Promise<ProcessEventPayload> {
  const dockerMap = await deps.collectDocker();
  const k8sMap = await deps.collectK8s();
  const claimed = new Set<number>([...dockerMap.keys(), ...k8sMap.keys()]);
  const hostList = deps.collectHost(claimed);

  // Build current map keyed by (pid, startedAt). Container sources already win
  // because host gap-fill skipped claimed PIDs.
  const current = new Map<string, ObservedProcess>();
  for (const p of dockerMap.values()) current.set(makeKey(p.pid, p.startedAt), p);
  for (const p of k8sMap.values()) current.set(makeKey(p.pid, p.startedAt), p);
  for (const p of hostList) current.set(makeKey(p.pid, p.startedAt), p);

  const spawns: SpawnEvent[] = [];
  const exits: ExitEvent[] = [];
  const argv_defs: ArgvDef[] = [];

  // Spawns: keys in current not in previous.
  for (const [key, p] of current) {
    if (!state.prevKeyToProc.has(key)) {
      spawns.push({
        pid: p.pid,
        ppid: p.ppid,
        argv_hash: p.argvHash,
        started_at: p.startedAt,
        source: p.source,
        container_id: p.containerId,
        pod_uid: p.podUid,
      });
      if (!state.shippedHashes.has(p.argvHash)) {
        argv_defs.push({ argv_hash: p.argvHash, argv: p.argv, comm: p.comm });
        state.shippedHashes.add(p.argvHash);
      }
    }
  }

  // Exits: keys in previous not in current.
  const nowMs = deps.now().getTime();
  for (const [key, prev] of state.prevKeyToProc) {
    if (!current.has(key)) {
      const startMs = Date.parse(prev.startedAt);
      exits.push({
        pid: prev.pid,
        started_at: prev.startedAt,
        exited_at: deps.now().toISOString(),
        exit_code: null,    // not derivable post-vanish via poll-diff
        lifetime_ms: Math.max(0, nowMs - startMs),
      });
    }
  }

  state.prevKeyToProc = current;

  return {
    cycle_at: deps.now().toISOString(),
    argv_defs,
    spawns,
    exits,
  };
}
```

- [ ] **Step 5: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-process-poller.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add agent/src/collectors/processes/poller.ts tests/unit/agent-process-poller.test.ts
git commit -m "feat(agent): process poller — cycle diff + attribution (#264)"
```

---

## Task 11: Agent collector entry point with MQTT + buffer

**Files:**
- Create: `agent/src/collectors/processes/index.ts`
- Test: `tests/unit/agent-process-mqtt-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/agent-process-mqtt-buffer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const { createPublisher } =
  require('../../agent/src/collectors/processes/index');

describe('process-event publisher with buffer', () => {
  it('publishes through when MQTT connected', () => {
    const sent: any[] = [];
    const mqtt = {
      connected: true,
      publish: (topic: string, payload: string) => sent.push({ topic, payload }),
    };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 5 });
    pub.publish({ cycle_at: 'n', argv_defs: [], spawns: [], exits: [] });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, 'insightd/h1/process_events');
  });

  it('buffers when disconnected, flushes on next publish after reconnect', () => {
    const sent: any[] = [];
    const mqtt = { connected: false, publish: (t: string, p: string) => sent.push({ t, p }) };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 5 });
    pub.publish({ cycle_at: 'A', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: 'B', argv_defs: [], spawns: [], exits: [] });
    assert.equal(sent.length, 0);
    assert.equal(pub.bufferSize(), 2);

    mqtt.connected = true;
    pub.publish({ cycle_at: 'C', argv_defs: [], spawns: [], exits: [] });
    // All three flushed in arrival order.
    assert.equal(sent.length, 3);
    assert.equal(JSON.parse(sent[0].p).cycle_at, 'A');
    assert.equal(JSON.parse(sent[2].p).cycle_at, 'C');
  });

  it('evicts oldest cycles when buffer overflows', () => {
    const mqtt = { connected: false, publish: () => {} };
    const pub = createPublisher({ mqtt, hostId: 'h1', bufferMaxCycles: 2 });
    pub.publish({ cycle_at: '1', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: '2', argv_defs: [], spawns: [], exits: [] });
    pub.publish({ cycle_at: '3', argv_defs: [], spawns: [], exits: [] });
    assert.equal(pub.bufferSize(), 2);
    const oldest = pub.peekOldest();
    assert.equal(oldest.cycle_at, '2');
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-process-mqtt-buffer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement publisher**

```typescript
// agent/src/collectors/processes/index.ts
import type { ProcessEventPayload } from '../../../../shared/types/process-events';
import logger = require('../../../../shared/utils/logger');

interface MqttLike {
  connected: boolean;
  publish: (topic: string, payload: string, opts?: { qos: 0 | 1 | 2 }) => void;
}

export interface PublisherOpts {
  mqtt: MqttLike;
  hostId: string;
  bufferMaxCycles: number;
}

export function createPublisher(opts: PublisherOpts) {
  const buffer: ProcessEventPayload[] = [];
  const topic = `insightd/${opts.hostId}/process_events`;

  function flush() {
    while (buffer.length > 0 && opts.mqtt.connected) {
      const head = buffer.shift()!;
      try {
        opts.mqtt.publish(topic, JSON.stringify(head), { qos: 0 });
      } catch (err) {
        logger.warn('processes', `mqtt publish failed: ${(err as Error).message}`);
        buffer.unshift(head);
        return;
      }
    }
  }

  return {
    publish(payload: ProcessEventPayload) {
      buffer.push(payload);
      while (buffer.length > opts.bufferMaxCycles) buffer.shift();
      if (opts.mqtt.connected) flush();
    },
    bufferSize: () => buffer.length,
    peekOldest: () => buffer[0],
    flush,
  };
}
```

- [ ] **Step 4: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-process-mqtt-buffer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/collectors/processes/index.ts tests/unit/agent-process-mqtt-buffer.test.ts
git commit -m "feat(agent): publisher with backpressure buffer (#264)"
```

---

## Task 12: Agent config additions

**Files:**
- Modify: `agent/src/config.ts`
- Test: `tests/unit/agent-process-config.test.ts`

- [ ] **Step 1: Inspect existing config shape**

Read `agent/src/config.ts` and find where existing collector toggles are defined (look for `INSIGHTD_RUNTIME` or any `collectorXyzEnabled` pattern). Match the parsing style.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/agent-process-config.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'INSIGHTD_PROCESS_ENABLED', 'INSIGHTD_PROCESS_INTERVAL_MS',
  'INSIGHTD_PROCESS_ARGV_MAX', 'INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS',
];

const savedEnv: Record<string, string | undefined> = {};

function loadConfig() {
  delete require.cache[require.resolve('../../agent/src/config')];
  return require('../../agent/src/config');
}

describe('agent process config', () => {
  before(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it('uses defaults when env absent', () => {
    const { config } = loadConfig();
    assert.equal(config.processCollection.enabled, true);
    assert.equal(config.processCollection.pollIntervalMs, 5000);
    assert.equal(config.processCollection.argvMaxBytes, 4096);
    assert.equal(config.processCollection.dockerTopTimeoutMs, 2000);
  });

  it('honors env overrides', () => {
    process.env.INSIGHTD_PROCESS_ENABLED = 'false';
    process.env.INSIGHTD_PROCESS_INTERVAL_MS = '10000';
    process.env.INSIGHTD_PROCESS_ARGV_MAX = '2048';
    process.env.INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS = '500';
    const { config } = loadConfig();
    assert.equal(config.processCollection.enabled, false);
    assert.equal(config.processCollection.pollIntervalMs, 10000);
    assert.equal(config.processCollection.argvMaxBytes, 2048);
    assert.equal(config.processCollection.dockerTopTimeoutMs, 500);
  });
});
```

- [ ] **Step 3: Run the test, see it fail**

Run: `npx tsx --test tests/unit/agent-process-config.test.ts`
Expected: FAIL — `config.processCollection` undefined.

- [ ] **Step 4: Add config block**

In `agent/src/config.ts`, add to the exported config object:

```typescript
processCollection: {
  enabled: process.env.INSIGHTD_PROCESS_ENABLED !== 'false',
  pollIntervalMs: parseInt(process.env.INSIGHTD_PROCESS_INTERVAL_MS ?? '5000', 10),
  argvMaxBytes: parseInt(process.env.INSIGHTD_PROCESS_ARGV_MAX ?? '4096', 10),
  dockerTopTimeoutMs: parseInt(process.env.INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS ?? '2000', 10),
},
```

- [ ] **Step 5: Re-run test, see it pass**

Run: `npx tsx --test tests/unit/agent-process-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add agent/src/config.ts tests/unit/agent-process-config.test.ts
git commit -m "feat(agent): config knobs for process collection (#264)"
```

---

## Task 13: Agent startup wiring

**Files:**
- Modify: `agent/src/index.ts`
- (No new test — covered by integration test in Task 15)

- [ ] **Step 1: Read the existing startup flow**

Open `agent/src/index.ts`. Locate where MQTT client is created and where existing collectors are started (look for `setInterval` or `cron.schedule` patterns).

- [ ] **Step 2: Add the wiring**

Near the existing collector setup, after `mqtt` is connected and `runtime` is detected:

```typescript
import { startProcessCollector } from './collectors/processes/processes';
// ...

// process visibility (#264)
if (config.processCollection.enabled) {
  startProcessCollector({
    mqtt: mqttClient,
    hostId: config.hostId,
    runtime,                            // 'docker' | 'kubernetes' | 'auto'
    docker,                             // dockerode instance
    config: config.processCollection,
    hostRoot: config.hostRoot,
  });
}
```

- [ ] **Step 3: Create the orchestrator entry**

Create `agent/src/collectors/processes/processes.ts` (separate file from `index.ts` which is the publisher; this one stitches everything together):

```typescript
// agent/src/collectors/processes/processes.ts
import * as fs from 'fs';
import * as path from 'path';
import { createPublisher } from './index';
import { newState, runPollCycle } from './poller';
import { walkProc } from './procWalk';
import { viaDockerTop } from './dockerTop';
import { viaCrictl, isCrictlAvailable } from './crictl';
import logger = require('../../../shared/utils/logger');

interface StartOpts {
  mqtt: any;
  hostId: string;
  runtime: 'docker' | 'kubernetes' | 'auto';
  docker: any;
  hostRoot: string;
  config: {
    pollIntervalMs: number;
    argvMaxBytes: number;
    dockerTopTimeoutMs: number;
  };
}

function readBootTimeMs(hostRoot: string): number {
  try {
    const stat = fs.readFileSync(path.join(hostRoot, 'proc', 'stat'), 'utf8');
    const m = stat.match(/^btime (\d+)/m);
    if (m) return parseInt(m[1], 10) * 1000;
  } catch { /* fall through */ }
  return Date.now();   // best-effort; new agents on long-running hosts will be ~off-by-uptime
}

export async function startProcessCollector(opts: StartOpts) {
  const procRoot = path.join(opts.hostRoot, 'proc');
  const bootTimeMs = readBootTimeMs(opts.hostRoot);
  const crictlAvailable = opts.runtime === 'kubernetes'
    ? await isCrictlAvailable()
    : false;

  if (opts.runtime === 'kubernetes' && !crictlAvailable) {
    logger.warn('processes', 'crictl binary not found; k8s process attribution disabled');
  }

  const state = newState();
  const pub = createPublisher({
    mqtt: opts.mqtt,
    hostId: opts.hostId,
    bufferMaxCycles: 60,
  });

  let inFlight = false;
  setInterval(async () => {
    if (inFlight) {
      logger.warn('processes', 'previous cycle still running; skipping');
      return;
    }
    inFlight = true;
    try {
      const containers = await opts.docker.listContainers({ all: false }).catch(() => []);
      const payload = await runPollCycle(state, {
        collectDocker: () => viaDockerTop(opts.docker, containers, {
          timeoutMs: opts.config.dockerTopTimeoutMs,
          bootTimeMs,
          argvMaxBytes: opts.config.argvMaxBytes,
        }),
        collectK8s: () => viaCrictl({
          runtime: opts.runtime,
          crictlAvailable,
          procRoot,
          bootTimeMs,
          argvMaxBytes: opts.config.argvMaxBytes,
        }),
        collectHost: (claimed) => walkProc({
          procRoot,
          bootTimeMs,
          claimedPids: claimed,
          argvMaxBytes: opts.config.argvMaxBytes,
        }),
        now: () => new Date(),
      });
      pub.publish(payload);
    } catch (err) {
      logger.error('processes', `cycle failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
  }, opts.config.pollIntervalMs);
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add agent/src/index.ts agent/src/collectors/processes/processes.ts
git commit -m "feat(agent): wire process collector into agent startup (#264)"
```

---

## Task 14: Dockerfile — install crictl

**Files:**
- Modify: `Dockerfile` (agent build stage) OR `agent/Dockerfile` if separate
- No test

- [ ] **Step 1: Identify the agent image build stage**

Run: `grep -n "FROM\|agent" Dockerfile`
Read the agent stage to find the package manager (alpine `apk` vs debian `apt-get`).

- [ ] **Step 2: Add crictl install**

If alpine:

```dockerfile
RUN apk add --no-cache crictl || \
    (CRICTL_VERSION=v1.30.0 && \
     wget -qO- https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-amd64.tar.gz | \
     tar -xz -C /usr/local/bin)
```

If debian/ubuntu:

```dockerfile
RUN CRICTL_VERSION=v1.30.0 && \
    curl -sSL https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-amd64.tar.gz | \
    tar -xz -C /usr/local/bin
```

Multi-arch note: replace `amd64` with `$(uname -m)` mapping if the agent image is built for both amd64 and arm64. The CI workflow in `.github/workflows/` is the source of truth for arch targets.

- [ ] **Step 3: Build the agent image locally to verify**

Run: `docker compose build agent`
Expected: build succeeds and `crictl` is on PATH inside the image (verify via `docker run --rm <agent-image> which crictl`).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build(agent): install crictl binary in agent image (#264)"
```

---

## Task 15: Integration test (end-to-end)

**Files:**
- Create: `tests/integration/process-events-e2e.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/process-events-e2e.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

const COMPOSE = 'docker compose -f docker-compose.yml';

describe('process events end-to-end', { skip: !process.env.RUN_E2E }, () => {
  before(() => {
    execSync(`${COMPOSE} up -d --build mosquitto hub agent`);
    execSync('sleep 10');   // wait for stack to settle and run schema bootstrap
    execSync(`docker run -d --name proc-test-victim alpine sh -c \
      'while true; do ls /tmp >/dev/null; sleep 0.5; done'`);
  });

  after(() => {
    try { execSync('docker rm -f proc-test-victim'); } catch {}
    execSync(`${COMPOSE} down -v`);
  });

  it('captures `ls` spawn rows from the victim container within 60s', () => {
    execSync('sleep 60');
    const out = execSync(
      `${COMPOSE} exec -T hub sqlite3 /data/insightd.db \
        "SELECT COUNT(*) FROM process_events WHERE argv_hash IN \
         (SELECT argv_hash FROM argv_dictionary WHERE comm='ls')"`,
    ).toString().trim();
    assert.ok(parseInt(out, 10) >= 60, `expected ≥60 ls spawns, got ${out}`);
  });
});
```

The `{ skip: !process.env.RUN_E2E }` opt-in keeps CI fast; run locally with `RUN_E2E=1 npm test -- tests/integration/process-events-e2e.test.ts`.

- [ ] **Step 2: Run the test locally**

Run: `RUN_E2E=1 npx tsx --test tests/integration/process-events-e2e.test.ts`
Expected: PASS within ~90s.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/process-events-e2e.test.ts
git commit -m "test(integration): process events end-to-end against compose stack (#264)"
```

---

## Task 16: Documentation + PR

**Files:**
- Modify: `CLAUDE.md` — update stale "Schema v33" reference
- New: PR description

- [ ] **Step 1: Update CLAUDE.md schema version**

Find the line:

```
SQLite with WAL mode. **Schema v33.**
```

Change to:

```
SQLite with WAL mode. **Schema v53.**
```

Also add a parenthetical to the table list near `insights` describing the new tables:

```
…ai_diagnoses (v21), argv_dictionary (v53), process_events (v53), alert_state, …
```

- [ ] **Step 2: Run the full suite + typecheck one last time**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 3: Commit + push + open PR**

```bash
git add CLAUDE.md
git commit -m "docs: update schema version reference (#264)"
git push -u origin feat/process-visibility

gh pr create \
  --base main \
  --title "feat: per-container process visibility pipeline (#264)" \
  --body "$(cat <<'EOF'
## Summary
- New schema v53 tables: argv_dictionary + process_events (spawn/exit events, 7d retention).
- Agent process collector polls Docker (docker top), k8s (crictl + /proc/<pid>/task/*/children), and host /proc every 5s and ships deltas over MQTT topic `insightd/<host>/process_events`.
- Hub ingests payloads with FK-free argv interning, UNIQUE constraint dedup, and orphan-exit tolerance.
- Daily prune at 03:30 (existing cron) handles retention.

Foundation PR. No detector, no UI — those land in #262 and #263 on top.

## Test plan
- [ ] `npm test` green
- [ ] `npm run typecheck` clean
- [ ] `RUN_E2E=1 npm test -- tests/integration/process-events-e2e.test.ts` passes against a fresh compose stack
- [ ] Manual: `docker compose up -d`, observe `process_events` row count grows in /data/insightd.db
- [ ] Manual: kill the agent, restart, confirm hub re-ingests after reconnect with no duplicate rows (UNIQUE constraint)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Known deferred work

- **Prometheus metrics.** The spec's Observability section lists `insightd_agent_process_*` and `insightd_hub_process_events_*` counters/histograms. The repo currently has no `prom-client` integration to extend. Adding a metrics framework is its own subsystem and should be a separate PR. Until then, the collector emits `logger.info`/`logger.warn` lines at cycle boundaries that operators can grep. Add a TODO comment in `agent/src/collectors/processes/processes.ts` next to the cycle counter sites so the wiring is obvious once the framework lands.

## Notes for the implementer

- Tests are colocated in top-level `tests/unit/` and `tests/integration/`, not under each package. The `npm test` glob is `tests/**/*.test.ts`.
- Logger module is `shared/utils/logger`; everywhere uses `import logger = require(...)` interop syntax — match it.
- `require('./...')` interop is the repo norm for module-level access to hub internals; do not switch to ESM-style imports for the new files unless you've checked the surrounding code uses them.
- Hub runs with `PRAGMA foreign_keys = ON` (`hub/src/db/connection.ts`). The spec deliberately leaves `argv_hash` as a plain column (no FK) — do not add `REFERENCES argv_dictionary(argv_hash)` to the schema.
- Standalone mode (`src/`) mirrors hub. Apply schema changes to BOTH `hub/src/db/schema.ts` and `src/db/schema.ts`. MQTT-specific changes (subscribe wiring) live only in `hub/src/mqtt.ts`.
- Use `require.cache` purge pattern (see `tests/unit/config.test.ts`) when a test needs to reload a module after mutating env vars.
- Branch off main and cherry-pick the spec commit (`55f7e73` on `feat/process-visibility-spec`) so the PR carries the spec doc alongside the implementation.
