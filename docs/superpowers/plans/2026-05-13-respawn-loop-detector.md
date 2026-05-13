# Respawn-loop detector implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an alert + insight that fires when a container is wedged in a process respawn loop, with the offending `argv` visible in the explain view, and which suppresses `high_cpu` / `high_memory` on the same container while firing.

**Architecture:** A single SQL aggregate over `process_events` per `(container_id, argv_hash)` window. One pure function in `hub/src/alerts/respawn-loop.ts` returns the firing groups; the alert evaluator routes them to `alert_state`, and the insight detector materializes corresponding `insights` rows with a `top_argvs` extras block reused on the frontend. Dependent suppression piggybacks on the DEPS map (PR #261), extended to support a new `container` scope.

**Tech Stack:** Node 20, TypeScript (strict), better-sqlite3, MQTT (already wired by PR #267), node:test, React 19.

**Spec:** [`docs/superpowers/specs/2026-05-13-respawn-loop-detector-design.md`](../specs/2026-05-13-respawn-loop-detector-design.md).

---

## File structure

```
hub/src/alerts/
  respawn-loop.ts        ← NEW. Pure detector logic + types.
  severity.ts            ← edit: register respawn_loop.
  dependencies.ts        ← edit: add 'container' scope + respawn_loop entry.
  rules.ts               ← edit (none required if severity.ts seeds — verify).
  evaluator.ts           ← edit: wire checkRespawnLoop into evaluateAlerts.

hub/src/insights/
  detector.ts            ← edit: materialize availability insights for respawn loops.
  explain.ts             ← edit: emit restart_histogram chart + top_argvs extras for kind=respawn_loop.
  explain-types.ts       ← edit: add ExtraBlock / TopArgvsBlock; add extras? to InsightExplanation.

hub/src/web/frontend/src/types/api.ts
  ← edit: mirror ExtraBlock / TopArgvsBlock and extras field.

hub/src/web/frontend/src/pages/insights/InsightExplain.tsx
  (or whichever component renders explain — verify in Task 7)
  ← edit: render extras blocks beneath the timeline.

hub/src/config.ts
  ← edit: register four env knobs.

hub/tests/alerts/
  respawn-loop.test.ts   ← NEW. Unit tests for detector + fetchTopArgvs.

hub/tests/alerts/dependencies.test.ts
  ← edit: add container-scope tests (or create new file if none exists — verify in Task 3).

tests/integration/respawn-loop-e2e.test.ts
  ← NEW. RUN_E2E-gated end-to-end test against compose stack.
```

**Naming convention:** alert_type is `respawn_loop` (not `container_respawn_loop` — matches existing unprefixed naming `restart_loop`, `high_cpu`, `image_pull_failure`). Spec used the prefixed name; plan diverges to match codebase pattern.

---

## Task 1: Detector core — types + SQL aggregate (TDD)

**Files:**
- Create: `hub/src/alerts/respawn-loop.ts`
- Create: `hub/tests/alerts/respawn-loop.test.ts`

- [ ] **Step 1.1: Write the failing test for `findActiveRespawnLoops` happy path**

Create `hub/tests/alerts/respawn-loop.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { findActiveRespawnLoops, fetchTopArgvs } = require('../../src/alerts/respawn-loop');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE argv_dictionary (
      argv_hash TEXT PRIMARY KEY,
      argv TEXT NOT NULL,
      comm TEXT,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      container_id TEXT,
      pod_uid TEXT,
      pid INTEGER NOT NULL,
      ppid INTEGER,
      argv_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      exited_at TEXT,
      exit_code INTEGER,
      lifetime_ms INTEGER,
      source TEXT NOT NULL,
      UNIQUE(host_id, pid, started_at)
    );
    CREATE INDEX idx_pe_container_started ON process_events(container_id, started_at);
  `);
  return db;
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

function seedSpawns(
  db: Database.Database,
  count: number,
  opts: { containerId: string; argvHash: string; lifetimeMs: number; minutesAgoStart: number },
): void {
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, argv_hash, started_at, exited_at, lifetime_ms, source)
    VALUES ('h1', ?, ?, ?, ?, ?, ?, 'docker')
  `);
  for (let i = 0; i < count; i++) {
    const startedAt = isoMinutesAgo(opts.minutesAgoStart - i * 0.01);
    const exitedAtMs = Date.parse(startedAt.replace(' ', 'T') + 'Z') + opts.lifetimeMs;
    const exitedAt = new Date(exitedAtMs).toISOString().slice(0, 19).replace('T', ' ');
    stmt.run(opts.containerId, 1000 + i, opts.argvHash, startedAt, exitedAt, opts.lifetimeMs);
  }
}

test('findActiveRespawnLoops fires on Jellyfin-shaped pattern', () => {
  const db = freshDb();
  seedSpawns(db, 25, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].containerId, 'c1');
  assert.equal(groups[0].argvHash, 'a1');
  assert.equal(groups[0].spawnCount, 25);
  assert.ok(groups[0].shortRatio >= 0.99);
});
```

- [ ] **Step 1.2: Run test, expect FAIL ("Cannot find module …respawn-loop")**

```bash
cd hub && npx tsx --test tests/alerts/respawn-loop.test.ts
```
Expected: failure mentioning module not found.

- [ ] **Step 1.3: Create `hub/src/alerts/respawn-loop.ts` with types and `findActiveRespawnLoops`**

```ts
import type Database from 'better-sqlite3';
import logger = require('../../../shared/utils/logger');

export interface RespawnLoopGroup {
  containerId: string;
  argvHash: string;
  spawnCount: number;
  shortRatio: number;
  avgLifetimeMs: number;
}

export interface TopArgv {
  argvHash: string;
  comm: string | null;
  argv: string;            // truncated to ARGV_TRUNCATE_BYTES
  spawnCount: number;
  avgLifetimeMs: number;
}

export interface DetectorParams {
  windowMin: number;
  minSpawns: number;
  shortLifetimeMs: number;
  shortLifetimeRatio: number;
}

const ARGV_TRUNCATE_BYTES = 200;

interface GroupRow {
  container_id: string;
  argv_hash: string;
  spawn_count: number;
  short_ratio: number;
  avg_lifetime_ms: number;
}

function findActiveRespawnLoops(
  db: Database.Database,
  now: Date,
  params: DetectorParams,
): RespawnLoopGroup[] {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  try {
    const rows = db.prepare(`
      WITH recent AS (
        SELECT container_id, argv_hash, lifetime_ms
          FROM process_events
         WHERE container_id IS NOT NULL
           AND started_at >= datetime(?, '-' || ? || ' minutes')
           AND exited_at IS NOT NULL
           AND lifetime_ms IS NOT NULL
      )
      SELECT container_id,
             argv_hash,
             COUNT(*) AS spawn_count,
             AVG(CASE WHEN lifetime_ms < ? THEN 1.0 ELSE 0.0 END) AS short_ratio,
             AVG(lifetime_ms) AS avg_lifetime_ms
        FROM recent
       GROUP BY container_id, argv_hash
      HAVING spawn_count >= ? AND short_ratio >= ?
    `).all(
      nowSql,
      params.windowMin,
      params.shortLifetimeMs,
      params.minSpawns,
      params.shortLifetimeRatio,
    ) as GroupRow[];

    return rows.map(r => ({
      containerId: r.container_id,
      argvHash: r.argv_hash,
      spawnCount: r.spawn_count,
      shortRatio: r.short_ratio,
      avgLifetimeMs: r.avg_lifetime_ms,
    }));
  } catch (err) {
    logger.warn({ err }, 'findActiveRespawnLoops query failed');
    return [];
  }
}

interface TopArgvRow {
  argv_hash: string;
  argv: string | null;
  comm: string | null;
  spawn_count: number;
  avg_lifetime_ms: number;
}

function fetchTopArgvs(
  db: Database.Database,
  containerId: string,
  now: Date,
  windowMin: number,
  limit: number = 5,
): TopArgv[] {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT pe.argv_hash,
           ad.argv,
           ad.comm,
           COUNT(*) AS spawn_count,
           AVG(pe.lifetime_ms) AS avg_lifetime_ms
      FROM process_events pe
      LEFT JOIN argv_dictionary ad ON ad.argv_hash = pe.argv_hash
     WHERE pe.container_id = ?
       AND pe.started_at >= datetime(?, '-' || ? || ' minutes')
     GROUP BY pe.argv_hash
     ORDER BY spawn_count DESC
     LIMIT ?
  `).all(containerId, nowSql, windowMin, limit) as TopArgvRow[];

  return rows.map(r => ({
    argvHash: r.argv_hash,
    comm: r.comm,
    argv: (r.argv ?? '').slice(0, ARGV_TRUNCATE_BYTES),
    spawnCount: r.spawn_count,
    avgLifetimeMs: r.avg_lifetime_ms ?? 0,
  }));
}

module.exports = { findActiveRespawnLoops, fetchTopArgvs };
```

- [ ] **Step 1.4: Run test, expect PASS**

```bash
cd hub && npx tsx --test tests/alerts/respawn-loop.test.ts
```
Expected: 1 pass.

- [ ] **Step 1.5: Add the rest of the unit cases**

Append to `hub/tests/alerts/respawn-loop.test.ts`:

```ts
test('no fire below MIN_SPAWNS', () => {
  const db = freshDb();
  seedSpawns(db, 19, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('no fire below short-lifetime ratio', () => {
  const db = freshDb();
  seedSpawns(db, 20, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 30_000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('20 distinct argv hashes (cron diversity) → no fire', () => {
  const db = freshDb();
  for (let i = 0; i < 20; i++) {
    seedSpawns(db, 1, { containerId: 'c1', argvHash: `a${i}`, lifetimeMs: 1000, minutesAgoStart: 14 - i * 0.5 });
  }
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('same argv across 2 containers → 2 distinct groups', () => {
  const db = freshDb();
  seedSpawns(db, 25, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  seedSpawns(db, 25, { containerId: 'c2', argvHash: 'a1', lifetimeMs: 3000, minutesAgoStart: 14 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  const ids = groups.map(g => g.containerId).sort();
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('still-running spawns (exited_at NULL) excluded from aggregate', () => {
  const db = freshDb();
  const stmt = db.prepare(`
    INSERT INTO process_events (host_id, container_id, pid, argv_hash, started_at, source)
    VALUES ('h1', 'c1', ?, 'a1', ?, 'docker')
  `);
  for (let i = 0; i < 25; i++) stmt.run(1000 + i, isoMinutesAgo(14 - i * 0.01));
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 0);
});

test('window boundary: spawn just inside window included; just outside excluded', () => {
  const db = freshDb();
  seedSpawns(db, 20, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 14.5 });
  seedSpawns(db, 5,  { containerId: 'c2', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 60 });
  const groups = findActiveRespawnLoops(db, new Date(), {
    windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].containerId, 'c1');
});

test('fetchTopArgvs returns DESC by spawn_count with comm + truncated argv', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen) VALUES (?, ?, ?, datetime('now'))`)
    .run('a1', '/usr/bin/ffmpeg -i /data/movies/' + 'x'.repeat(500), 'ffmpeg');
  db.prepare(`INSERT INTO argv_dictionary (argv_hash, argv, comm, first_seen) VALUES (?, ?, ?, datetime('now'))`)
    .run('a2', '/bin/sh', 'sh');
  seedSpawns(db, 10, { containerId: 'c1', argvHash: 'a1', lifetimeMs: 1000, minutesAgoStart: 5 });
  seedSpawns(db, 3,  { containerId: 'c1', argvHash: 'a2', lifetimeMs: 1000, minutesAgoStart: 5 });
  const argvs = fetchTopArgvs(db, 'c1', new Date(), 15);
  assert.equal(argvs.length, 2);
  assert.equal(argvs[0].argvHash, 'a1');
  assert.equal(argvs[0].comm, 'ffmpeg');
  assert.ok(argvs[0].argv.length <= 200);
  assert.equal(argvs[1].argvHash, 'a2');
});
```

- [ ] **Step 1.6: Run the whole test file, expect all PASS**

```bash
cd hub && npx tsx --test tests/alerts/respawn-loop.test.ts
```
Expected: 7 pass, 0 fail.

- [ ] **Step 1.7: Commit**

```bash
git add hub/src/alerts/respawn-loop.ts hub/tests/alerts/respawn-loop.test.ts
git commit -m "feat(alerts): respawn-loop detector core (#262)"
```

---

## Task 2: Register `respawn_loop` severity + description

**Files:**
- Modify: `hub/src/alerts/severity.ts`

- [ ] **Step 2.1: Read the current file**

```bash
cat hub/src/alerts/severity.ts
```

- [ ] **Step 2.2: Add entry to both maps**

Edit `hub/src/alerts/severity.ts` — in `DEFAULT_SEVERITY` add:
```ts
respawn_loop:                'warning',
```
And in `ALERT_DESCRIPTIONS`:
```ts
respawn_loop:                'A container is spawning the same process repeatedly with short lifetimes — likely an internal crash loop.',
```

- [ ] **Step 2.3: Verify rules seed picks up the new type**

`hub/src/alerts/rules.ts:ensureRulesSeeded` iterates `DEFAULT_SEVERITY`, so the new row will seed automatically with `severity='warning', enabled=1, mail=0, webhook=1` (per the synthetic default). This matches the spec ("mail off by default").

Run any existing rules test to confirm no regression:

```bash
cd hub && npx tsx --test tests/alerts/rules.test.ts 2>&1 | tail -5
```

If the test file doesn't exist, skip — covered by integration test later.

- [ ] **Step 2.4: Commit**

```bash
git add hub/src/alerts/severity.ts
git commit -m "feat(alerts): register respawn_loop severity + description (#262)"
```

---

## Task 3: Extend DEPS with `container` scope + add respawn_loop entry

**Files:**
- Modify: `hub/src/alerts/dependencies.ts`
- Test: `hub/tests/alerts/dependencies.test.ts` (create if missing)

- [ ] **Step 3.1: Confirm whether a tests file already exists**

```bash
ls hub/tests/alerts/dependencies.test.ts 2>&1
```

If it exists, append tests in Step 3.2. If not, create a new file with the test below.

- [ ] **Step 3.2: Write failing test for container scope**

Add to `hub/tests/alerts/dependencies.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { findActiveParent, findActiveChildren } = require('../../src/alerts/dependencies');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hosts (host_id TEXT PRIMARY KEY, proxmox_cluster_id TEXT);
    CREATE TABLE alert_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      host_id TEXT NOT NULL,
      target TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  db.prepare('INSERT INTO hosts (host_id) VALUES (?)').run('h1');
  return db;
}

test('container scope: respawn_loop on container X suppresses high_cpu on same container only', () => {
  const db = freshDb();
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('respawn_loop', 'h1', 'jellyfin');

  const matchSame = findActiveParent(db, { type: 'high_cpu', hostId: 'h1', target: 'jellyfin' });
  assert.ok(matchSame, 'same-container parent should match');
  assert.equal(matchSame.alert_type, 'respawn_loop');

  const matchOther = findActiveParent(db, { type: 'high_cpu', hostId: 'h1', target: 'plex' });
  assert.equal(matchOther, null, 'different-container parent must not match');
});

test('container scope: findActiveChildren filters by target', () => {
  const db = freshDb();
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('high_cpu', 'h1', 'jellyfin');
  db.prepare('INSERT INTO alert_state (alert_type, host_id, target) VALUES (?,?,?)')
    .run('high_cpu', 'h1', 'plex');

  const children = findActiveChildren(db, { alert_type: 'respawn_loop', host_id: 'h1', target: 'jellyfin' });
  const targets = children.map((c: any) => c.target);
  assert.deepEqual(targets, ['jellyfin']);
});
```

- [ ] **Step 3.3: Run test, expect FAIL**

```bash
cd hub && npx tsx --test tests/alerts/dependencies.test.ts
```
Expected: both tests fail — `findActiveParent` doesn't know about respawn_loop, `findActiveChildren` signature lacks `target`.

- [ ] **Step 3.4: Edit `hub/src/alerts/dependencies.ts`**

Apply these changes:

1. Extend the scope type:
```ts
type ScopeKey = 'host' | 'cluster' | 'container';
```

2. Add the DEPS entry (append to the array):
```ts
{
  parent: 'respawn_loop',
  scope: 'container',
  children: ['high_cpu', 'high_memory'],
},
```

3. Extend `findActiveParent` to handle container scope. After the `if (dep.scope === 'host')` branch and before the cluster branch, add:
```ts
} else if (dep.scope === 'container') {
  row = db.prepare(`
    SELECT id, alert_type, host_id, target FROM alert_state
    WHERE alert_type = ? AND host_id = ? AND target = ? AND resolved_at IS NULL
    LIMIT 1
  `).get(dep.parent, alert.hostId, alert.target) as ParentRow | undefined;
```
(Restructure the existing if/else chain accordingly.)

4. Extend `findActiveChildren` to filter by `target` when scope is container. Change the signature of `ParentLike` to add an optional `target`:
```ts
interface ParentLike { alert_type: string; host_id: string; target?: string }
```
And inside the function, add a container branch:
```ts
if (dep.scope === 'container') {
  return db.prepare(`
    SELECT id, alert_type, host_id, target, resolved_at FROM alert_state
    WHERE host_id = ? AND target = ? AND alert_type IN (${placeholders})
  `).all(parent.host_id, parent.target ?? '', ...dep.children) as any;
}
```

- [ ] **Step 3.5: Run dep tests, expect PASS**

```bash
cd hub && npx tsx --test tests/alerts/dependencies.test.ts
```
Expected: 2 pass.

- [ ] **Step 3.6: Run the existing alert test suite to confirm no regression**

```bash
cd hub && npx tsx --test 'tests/alerts/**/*.test.ts' 2>&1 | tail -10
```
Expected: existing host/cluster scope tests still pass.

- [ ] **Step 3.7: Commit**

```bash
git add hub/src/alerts/dependencies.ts hub/tests/alerts/dependencies.test.ts
git commit -m "feat(alerts): container-scope DEPS + respawn_loop → high_cpu/memory (#262)"
```

---

## Task 4: Wire the detector into `evaluateAlerts`

**Files:**
- Modify: `hub/src/alerts/evaluator.ts`

- [ ] **Step 4.1: Read the area around `checkRestartLoop` to match the style**

```bash
sed -n '270,310p' hub/src/alerts/evaluator.ts
```

- [ ] **Step 4.2: Add the import at the top of `evaluator.ts`**

After the existing `const { … } = require('./severity');` line, add:
```ts
const { findActiveRespawnLoops } = require('./respawn-loop');
```

- [ ] **Step 4.3: Add config knob shapes**

Inside `interface AlertsConfig` add:
```ts
respawnLoop?: boolean;            // master enable, default true
respawnWindowMin?: number;        // default 15
respawnMinSpawns?: number;        // default 20
respawnShortLifetimeMs?: number;  // default 10000
respawnShortLifetimeRatio?: number; // default 0.6
```

- [ ] **Step 4.4: Add a check function below `checkRestartLoop`**

Append to `hub/src/alerts/evaluator.ts` (before `oomCauseSuffix`):

```ts
function checkRespawnLoop(db: Database.Database, params: {
  windowMin: number; minSpawns: number; shortLifetimeMs: number; shortLifetimeRatio: number;
}): AlertItem[] {
  const groups = findActiveRespawnLoops(db, new Date(), params);
  const out: AlertItem[] = [];
  for (const g of groups) {
    const hostRow = db.prepare(
      'SELECT host_id, container_name FROM container_snapshots WHERE container_id = ? ORDER BY collected_at DESC LIMIT 1'
    ).get(g.containerId) as { host_id: string; container_name: string } | undefined;
    if (!hostRow) continue;
    out.push({
      type: 'respawn_loop',
      hostId: hostRow.host_id,
      target: hostRow.container_name,
      message:
        `Container "${hostRow.container_name}" has spawned the same process ${g.spawnCount} times in the last 15 min ` +
        `(${(g.shortRatio * 100).toFixed(0)}% lifetime < 10s, avg ${Math.round(g.avgLifetimeMs)} ms).`,
      value: g.spawnCount,
      threshold: params.minSpawns,
    });
  }
  return out;
}
```

(Container name is looked up via container_snapshots since `process_events` only has `container_id`; same lookup pattern as other container alerts.)

- [ ] **Step 4.5: Call it from `evaluateAlerts`**

Inside the per-host loop (around the existing `checkRestartLoop` call), add:

```ts
if (alerts.respawnLoop !== false) {
  triggered.push(...checkRespawnLoop(db, {
    windowMin: alerts.respawnWindowMin ?? 15,
    minSpawns: alerts.respawnMinSpawns ?? 20,
    shortLifetimeMs: alerts.respawnShortLifetimeMs ?? 10_000,
    shortLifetimeRatio: alerts.respawnShortLifetimeRatio ?? 0.6,
  }).filter(notExcluded));
}
```

Note: detector is host-agnostic (groups by container_id only). Call it ONCE outside the per-host loop, **not** inside, to avoid evaluating once per host. Move the call below the per-host loop, near `checkDiskFull`:

```ts
if (alerts.respawnLoop !== false) {
  triggered.push(...checkRespawnLoop(db, { … }).filter(notExcluded));
}
```

Remove the per-host placement.

- [ ] **Step 4.6: Resolution wiring**

Search for the resolution block that handles `'restart_loop'` to mirror it:

```bash
grep -n "'restart_loop'" hub/src/alerts/evaluator.ts
```

Locate the array around line 1022 (`'restart_loop'` in the resolution-eligible types list) and add `'respawn_loop'` to it. Locate the switch / if-chain around line 1096 / 1339 and add a `respawn_loop` resolution case that mirrors `restart_loop`:

```ts
} else if (alert.alert_type === 'respawn_loop') {
  const stillFiring = findActiveRespawnLoops(db, new Date(), {
    windowMin: alerts.respawnWindowMin ?? 15,
    minSpawns: alerts.respawnMinSpawns ?? 20,
    shortLifetimeMs: alerts.respawnShortLifetimeMs ?? 10_000,
    shortLifetimeRatio: alerts.respawnShortLifetimeRatio ?? 0.6,
  }).some(g => {
    const cn = db.prepare(
      'SELECT container_name FROM container_snapshots WHERE container_id = ? ORDER BY collected_at DESC LIMIT 1'
    ).get(g.containerId) as { container_name: string } | undefined;
    return cn?.container_name === alert.target && alert.host_id === alert.host_id;
  });
  if (!stillFiring) { /* mark resolved using the same pattern as restart_loop */ }
}
```

And add a resolution message case (around line 1339):
```ts
case 'respawn_loop': return `Container "${target}"${on} respawn loop resolved`;
```

- [ ] **Step 4.7: Typecheck**

```bash
cd hub && npx tsc --noEmit 2>&1 | tail -20
```
Expected: zero errors.

- [ ] **Step 4.8: Run all alert tests**

```bash
cd hub && npx tsx --test 'tests/alerts/**/*.test.ts' 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 4.9: Commit**

```bash
git add hub/src/alerts/evaluator.ts
git commit -m "feat(alerts): wire respawn_loop into evaluator + resolution (#262)"
```

---

## Task 5: Materialize availability insights for respawn loops

**Files:**
- Modify: `hub/src/insights/detector.ts`

- [ ] **Step 5.1: Find where availability insights are written**

```bash
grep -n "category: 'availability'\|category = 'availability'\|insertInsight\|upsertInsight" hub/src/insights/detector.ts | head -10
```

Note the function name and signature used to write rows.

- [ ] **Step 5.2: Add import at top of detector.ts**

```ts
const { findActiveRespawnLoops, fetchTopArgvs } = require('../alerts/respawn-loop');
```

- [ ] **Step 5.3: Inside `generateInsights`, after the existing availability checks, append a respawn-loop block**

Use the exact same `insertInsight` / `upsertInsight` helper the file already exposes. Discover it from Step 5.1 output. Pseudocode (replace `insertInsight(...)` with the real helper):

```ts
const respawnGroups = findActiveRespawnLoops(db, new Date(), {
  windowMin: 15, minSpawns: 20, shortLifetimeMs: 10_000, shortLifetimeRatio: 0.6,
});
for (const g of respawnGroups) {
  const row = db.prepare(
    'SELECT host_id, container_name FROM container_snapshots WHERE container_id = ? ORDER BY collected_at DESC LIMIT 1'
  ).get(g.containerId) as { host_id: string; container_name: string } | undefined;
  if (!row) continue;
  const topArgvs = fetchTopArgvs(db, g.containerId, new Date(), 15);
  const title = `Respawn loop in "${row.container_name}"`;
  const message =
    `${g.spawnCount} spawns of the same process in 15 min, ` +
    `${(g.shortRatio * 100).toFixed(0)}% finished in <10s (avg ${Math.round(g.avgLifetimeMs)} ms).`;
  const evidence = JSON.stringify({
    argv_hash: g.argvHash,
    spawn_count: g.spawnCount,
    short_ratio: g.shortRatio,
    avg_lifetime_ms: g.avgLifetimeMs,
    top_argvs: topArgvs.map(t => ({
      argv_hash: t.argvHash,
      comm: t.comm,
      argv: t.argv,
      spawn_count: t.spawnCount,
      avg_lifetime_ms: t.avgLifetimeMs,
    })),
  });
  insertInsight({
    entity_type: 'container',
    entity_id: row.container_name,
    host_id: row.host_id,
    category: 'availability',
    kind: 'respawn_loop',
    metric: 'process_spawn_count',
    title,
    message,
    evidence,
    confidence: 'high',
  });
}
```

Adapt the literal field names to whatever `insertInsight` / `upsertInsight` accepts in this codebase.

- [ ] **Step 5.4: Typecheck**

```bash
cd hub && npx tsc --noEmit 2>&1 | tail -20
```
Expected: zero errors.

- [ ] **Step 5.5: Run insight tests**

```bash
cd hub && npx tsx --test 'tests/insights/**/*.test.ts' 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 5.6: Commit**

```bash
git add hub/src/insights/detector.ts
git commit -m "feat(insights): materialize respawn_loop availability insight (#262)"
```

---

## Task 6: Explain — `restart_histogram` chart + `top_argvs` extras block

**Files:**
- Modify: `hub/src/insights/explain-types.ts`
- Modify: `hub/src/insights/explain.ts`
- Modify: `hub/src/web/frontend/src/types/api.ts`

- [ ] **Step 6.1: Extend `explain-types.ts`**

Replace the file with:

```ts
// hub/src/insights/explain-types.ts
//
// Shape of GET /api/insights/:id/explain response. Frontend mirrors these
// types in src/types/api.ts (hand-copied; no shared module across the CJS
// backend / ESM frontend boundary, matching the existing pattern).

export type ChartKind = 'sparkline' | 'week_overlay' | 'forecast' | 'uptime_bars' | 'restart_histogram';

export interface ChartPoint {
  ts: string;
  value: number;
}

export interface ForecastPoint {
  ts: string;
  lower: number;
  upper: number;
  mid: number;
}

export interface UptimeInterval {
  from: string;
  to: string;
  up: boolean;
}

export interface ChartData {
  kind: ChartKind;
  points: ChartPoint[];
  compare?: ChartPoint[];
  forecast?: ForecastPoint[];
  uptime?: UptimeInterval[];
  threshold?: number;
  thresholdLabel?: string;
  yLabel?: string;
}

export type TimelineKind = 'log_burst' | 'alert_fired' | 'restart' | 'threshold_cross' | 'event';

export interface TimelineMarker {
  ts: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  severity?: 'critical' | 'warning' | 'info';
  href?: string;
}

export interface ExplanationSummary {
  lead: string;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface TopArgvsRow {
  argv_hash: string;
  comm: string | null;
  argv: string;             // already truncated to ≤200 chars by backend
  spawn_count: number;
  avg_lifetime_ms: number;
}

export interface TopArgvsBlock {
  kind: 'top_argvs';
  rows: TopArgvsRow[];
}

export type ExtraBlock = TopArgvsBlock;

export interface InsightExplanation {
  summary: ExplanationSummary;
  chart: ChartData;
  timeline: TimelineMarker[];
  extras?: ExtraBlock[];
}
```

- [ ] **Step 6.2: Update `explain.ts` to handle `respawn_loop` kind**

Find the existing dispatch on insight `kind` in `hub/src/insights/explain.ts` (search for `'restart_histogram'` and the surrounding switch). Add a branch for `kind === 'respawn_loop'`:

```ts
if (insight.kind === 'respawn_loop') {
  // Hourly spawn-count histogram for THIS argv_hash over the last 24h.
  const evidence = JSON.parse(insight.evidence ?? '{}') as { argv_hash?: string; top_argvs?: TopArgvsRow[] };
  const argvHash = evidence.argv_hash ?? '';
  const hourlyRows = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00:00', started_at) AS hour, COUNT(*) AS n
      FROM process_events
     WHERE container_id IN (
             SELECT container_id FROM container_snapshots
              WHERE container_name = ?
              ORDER BY collected_at DESC LIMIT 1
           )
       AND argv_hash = ?
       AND started_at >= datetime('now', '-24 hours')
     GROUP BY hour
     ORDER BY hour
  `).all(insight.entity_id, argvHash) as { hour: string; n: number }[];

  const chart: ChartData = {
    kind: 'restart_histogram',
    points: hourlyRows.map(r => ({ ts: r.hour, value: r.n })),
  };
  const extras: ExtraBlock[] = evidence.top_argvs?.length
    ? [{ kind: 'top_argvs', rows: evidence.top_argvs }]
    : [];

  return {
    summary: {
      lead: insight.message ?? '',
      reasons: [],
      confidence: insight.confidence ?? null,
    },
    chart,
    timeline: [],
    extras,
  };
}
```

Place this branch alongside the other kind-specific branches.

- [ ] **Step 6.3: Mirror types in frontend `api.ts`**

Edit `hub/src/web/frontend/src/types/api.ts`. Locate the existing `InsightExplanation` shape and add the same `TopArgvsRow`, `TopArgvsBlock`, `ExtraBlock` interfaces plus `extras?: ExtraBlock[]` field.

- [ ] **Step 6.4: Typecheck both halves**

```bash
cd hub && npx tsc --noEmit 2>&1 | tail -5
cd hub/src/web/frontend && npx tsc --noEmit 2>&1 | tail -5
```
Expected: both clean.

- [ ] **Step 6.5: Commit**

```bash
git add hub/src/insights/explain.ts hub/src/insights/explain-types.ts hub/src/web/frontend/src/types/api.ts
git commit -m "feat(insights): explain endpoint emits restart_histogram + top_argvs (#262)"
```

---

## Task 7: Frontend — render `top_argvs` extras block

**Files:**
- Modify: the React component that renders insight explain (verify path before editing).

- [ ] **Step 7.1: Locate the component**

```bash
grep -rn "ChartData\|InsightExplanation" hub/src/web/frontend/src --include='*.tsx' -l | head -5
```

The component that renders the chart + timeline is the right place to add the extras list. Open it and confirm.

- [ ] **Step 7.2: Add a small `TopArgvsTable` subcomponent**

In the same file (or a new sibling file in the same directory), add:

```tsx
import type { TopArgvsBlock } from '../../types/api';

function TopArgvsTable({ rows }: TopArgvsBlock) {
  if (!rows.length) return null;
  return (
    <div className="mt-4 border rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900 text-xs font-medium uppercase tracking-wide">
        Top spawned processes (last 15 min)
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="text-left px-3 py-1.5">Command</th>
            <th className="text-right px-3 py-1.5">Spawns</th>
            <th className="text-right px-3 py-1.5">Avg lifetime</th>
            <th className="text-left px-3 py-1.5">Argv</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.argv_hash} className="border-t">
              <td className="px-3 py-1.5 font-mono">{r.comm ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.spawn_count}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{Math.round(r.avg_lifetime_ms)} ms</td>
              <td className="px-3 py-1.5 font-mono text-xs break-all">{r.argv}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 7.3: Render extras in the parent**

Where the parent renders `<TimelineList … />` (or equivalent), add below it:

```tsx
{explanation.extras?.map((block, i) => {
  if (block.kind === 'top_argvs') return <TopArgvsTable key={i} {...block} />;
  return null;
})}
```

- [ ] **Step 7.4: Build the frontend to verify**

```bash
cd hub/src/web/frontend && npm run build 2>&1 | tail -5
```
Expected: build succeeds.

- [ ] **Step 7.5: Commit**

```bash
git add hub/src/web/frontend/src
git commit -m "feat(ui): top_argvs table in insight explain (#262)"
```

---

## Task 8: Config — wire env knobs into `hub/src/config.ts`

**Files:**
- Modify: `hub/src/config.ts`

- [ ] **Step 8.1: Locate where existing alert knobs are parsed**

```bash
grep -n "alerts:\|hostCpuPercent:\|restartCount:" hub/src/config.ts | head -10
```

- [ ] **Step 8.2: Add the four env knobs**

In the alerts config object, add:

```ts
respawnLoop:               envBool('INSIGHTD_RESPAWN_ENABLED', true),
respawnWindowMin:          envNum('INSIGHTD_RESPAWN_WINDOW_MIN', 15),
respawnMinSpawns:          envNum('INSIGHTD_RESPAWN_MIN_SPAWNS', 20),
respawnShortLifetimeMs:    envNum('INSIGHTD_RESPAWN_SHORT_LIFETIME_MS', 10_000),
respawnShortLifetimeRatio: envNum('INSIGHTD_RESPAWN_SHORT_LIFETIME_RATIO', 0.6),
```

Use whatever helpers `config.ts` already provides for env parsing (likely `envBool` / `envNum` or inline `Number(process.env.X) || default`). Match the style of the surrounding code.

- [ ] **Step 8.3: Document in CLAUDE.md "Key Environment Variables" section**

Edit `CLAUDE.md` — add to the env-vars list:

```
- `INSIGHTD_RESPAWN_ENABLED` / `INSIGHTD_RESPAWN_WINDOW_MIN` / `INSIGHTD_RESPAWN_MIN_SPAWNS` / `INSIGHTD_RESPAWN_SHORT_LIFETIME_MS` / `INSIGHTD_RESPAWN_SHORT_LIFETIME_RATIO` — respawn-loop detector thresholds (defaults: on / 15 / 20 / 10000 / 0.6)
```

- [ ] **Step 8.4: Typecheck**

```bash
cd hub && npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 8.5: Commit**

```bash
git add hub/src/config.ts CLAUDE.md
git commit -m "feat(config): env knobs for respawn-loop detector (#262)"
```

---

## Task 9: Integration test — RUN_E2E end-to-end

**Files:**
- Create: `tests/integration/respawn-loop-e2e.test.ts`

- [ ] **Step 9.1: Read the existing process-events e2e test for the compose harness pattern**

```bash
head -80 tests/integration/process-events-e2e.test.ts
```

- [ ] **Step 9.2: Create the new e2e test**

Create `tests/integration/respawn-loop-e2e.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';

const RUN = process.env.RUN_E2E === '1';
const COMPOSE = process.env.COMPOSE_FILE ?? 'docker-compose.yml';

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

test('respawn-loop detector fires + insight materializes', { skip: !RUN }, async () => {
  // Override detector to lower MIN_SPAWNS so the test runs in ~60s instead of 15min.
  process.env.INSIGHTD_RESPAWN_MIN_SPAWNS = '5';
  process.env.INSIGHTD_RESPAWN_WINDOW_MIN = '2';

  sh(`docker compose -f ${COMPOSE} up -d --build`);
  try {
    // Spawn a victim container that respawns sh every 0.5s with quick exit.
    sh(`docker run -d --name respawn-victim --rm alpine:3.20 sh -c "while true; do sleep 0.5; sh -c 'exit 1'; done"`);
    try {
      // Wait 90s for agent to publish enough process_events + hub to evaluate.
      await new Promise(r => setTimeout(r, 90_000));

      const dbPath = process.env.HUB_DB_PATH ?? './data/insightd.db';
      const db = new Database(dbPath, { readonly: true });

      const alert = db.prepare(
        `SELECT id FROM alert_state WHERE alert_type = 'respawn_loop' AND resolved_at IS NULL LIMIT 1`
      ).get();
      assert.ok(alert, 'expected an active respawn_loop alert_state row');

      const insight = db.prepare(
        `SELECT id, evidence FROM insights WHERE category = 'availability' AND kind = 'respawn_loop' LIMIT 1`
      ).get() as { id: number; evidence: string } | undefined;
      assert.ok(insight, 'expected a respawn_loop insight row');
      const evidence = JSON.parse(insight.evidence);
      assert.ok(Array.isArray(evidence.top_argvs) && evidence.top_argvs.length >= 1,
        'expected top_argvs evidence with ≥1 row');
    } finally {
      sh('docker rm -f respawn-victim || true');
    }
  } finally {
    sh(`docker compose -f ${COMPOSE} down -v`);
  }
});
```

- [ ] **Step 9.3: Smoke-run locally with `RUN_E2E=1`**

```bash
RUN_E2E=1 npx tsx --test tests/integration/respawn-loop-e2e.test.ts 2>&1 | tail -10
```
Expected: pass. If it fails because compose paths differ, adjust `COMPOSE` default to whatever the repo uses.

- [ ] **Step 9.4: Commit**

```bash
git add tests/integration/respawn-loop-e2e.test.ts
git commit -m "test(integration): respawn-loop end-to-end against compose (#262)"
```

---

## Task 10: Memory update + PR

**Files:**
- Modify: `/home/andreas/.claude/projects/-home-andreas/memory/project_insightd.md`
- Modify: `/home/andreas/.claude/projects/-home-andreas/memory/MEMORY.md` (one-line index update)

- [ ] **Step 10.1: Verify full test matrix**

```bash
cd hub && npm test 2>&1 | tail -20
cd hub && npx tsc --noEmit 2>&1 | tail -5
cd hub/src/web/frontend && npm run build 2>&1 | tail -5
```
Expected: all green.

- [ ] **Step 10.2: Manual validation on vdev**

Per the `reference_insightd_ops` memory (deploy loop):
1. Deploy current branch to vdev.
2. SSH to vdev, run alpine victim spawning `sh -c "exit 1"` every 0.3s for ~30s.
3. Open Alerts page → confirm `respawn_loop` alert appears.
4. Open container detail → Insights tab → confirm respawn_loop insight with `top_argvs` table rendered.
5. Trigger `high_cpu` simultaneously on the same container (CPU stress) → confirm `respawn_loop` shows but `high_cpu` is suppressed (visible as `suppressed_by` state).
6. Stop the victim → confirm both alert and insight resolve within ~16 min (window slides out).

- [ ] **Step 10.3: Push branch + open PR**

```bash
git push -u origin feat/respawn-loop-detector
gh pr create --title "Respawn-loop detector + dependent suppression (#262)" --body "$(cat <<'EOF'
## Summary
- Adds `respawn_loop` alert + availability insight when a container is wedged in a process respawn loop. Fires at ≥20 spawns of the same argv_hash with ≥60% lifetime <10s over a 15-minute window.
- Suppresses `high_cpu` and `high_memory` on the same container via the DEPS map (extended with a new `container` scope).
- Insight explain reuses `restart_histogram` for hourly spawn counts and adds a `top_argvs` extras block with comm + truncated argv + median lifetime.
- Spec: `docs/superpowers/specs/2026-05-13-respawn-loop-detector-design.md`.

## Test plan
- [ ] `npm test` (hub) green
- [ ] `tsc --noEmit` green (hub + frontend)
- [ ] `RUN_E2E=1 npx tsx --test tests/integration/respawn-loop-e2e.test.ts` green
- [ ] Manual vdev test: victim container fires alert + insight; `high_cpu` suppressed; resolution after window slides

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10.4: After merge — update memory**

(Per `feedback_post_merge_memory`.) Append one bullet to `project_insightd.md` (top of date-sorted list) and update the index line in `MEMORY.md` if needed. The bullet should be one line summarizing:
- PR # and schema (no change)
- Detector function name + thresholds
- DEPS scope extension (host/cluster/container)
- Alert type `respawn_loop` vs existing `restart_loop`

---

## Self-review notes

**Spec coverage:**
- Detector logic + thresholds → Task 1
- Alert wiring + severity → Tasks 2, 4
- DEPS suppression → Task 3
- Insight materialization → Task 5
- Explain + top_argvs → Task 6
- Frontend render → Task 7
- Env knobs → Task 8
- Tests → Tasks 1 (unit), 3 (DEPS), 9 (e2e)

**Type consistency:**
- Detector returns `RespawnLoopGroup` with `containerId`, `argvHash`, `spawnCount`, `shortRatio`, `avgLifetimeMs` — used consistently in evaluator (Task 4) and detector (Task 5).
- `TopArgv` from backend maps to `TopArgvsRow` interface in `api.ts` — backend exposes camelCase fields (`argvHash`, `spawnCount`, `avgLifetimeMs`); frontend types use snake_case mirror (`argv_hash`, `spawn_count`, `avg_lifetime_ms`). This matches the existing `ChartPoint` / `TimelineMarker` pattern (snake_case at API boundary, the JSON shape is set by `JSON.stringify` over the backend object, so the backend must serialize as snake_case keys). **Fix in plan:** in Task 1, change `RespawnLoopGroup` field names that go into the JSON evidence to snake_case (`argv_hash`, `spawn_count`, `short_ratio`, `avg_lifetime_ms`) when written into evidence JSON in Task 5; keep camelCase only for in-process function signatures. Task 5 already writes snake_case keys explicitly in the `JSON.stringify` payload, so the API boundary is correct as-written.
- `fetchTopArgvs` returns `TopArgv` objects with `argvHash` (camelCase); Task 5 needs to map these to snake_case keys when packing into evidence JSON. Update Task 5 step 5.3 accordingly:
  ```ts
  top_argvs: topArgvs.map(t => ({
    argv_hash: t.argvHash, comm: t.comm, argv: t.argv,
    spawn_count: t.spawnCount, avg_lifetime_ms: t.avgLifetimeMs,
  })),
  ```

**Placeholder scan:** None remain.

**Scope check:** Single PR, ~10 commits, fits one review cycle.
