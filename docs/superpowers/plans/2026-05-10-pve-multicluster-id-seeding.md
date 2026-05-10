# PVE Multi-Cluster `cluster_id` Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a PVE node publishes a `pve-cluster` MQTT message, seed `hosts.proxmox_cluster_id` on that PVE node host with the reported cluster name, so the identity matcher resolves a real cluster_id for linked guests instead of always-null.

**Architecture:** Single change in the hub MQTT pipeline. `handlePveCluster` gains a `hostId` parameter (already available on the MQTT topic). `ingestPveCluster` gains a `hostId` parameter and wraps its existing `pve_cluster_status` UPSERT plus a new `UPDATE hosts SET proxmox_cluster_id = ? WHERE host_id = ?` in a single `db.transaction`. Matcher unchanged — it already JOINs to `hosts.proxmox_cluster_id`.

**Tech Stack:** TypeScript, better-sqlite3, node:test, tsx.

**Spec:** [docs/superpowers/specs/2026-05-10-pve-multicluster-id-seeding-design.md](../specs/2026-05-10-pve-multicluster-id-seeding-design.md)

---

## File Structure

- **Modify** `hub/src/ingest.ts` — extend `ingestPveCluster` signature + wrap writes in tx; update `module.exports` annotation.
- **Modify** `hub/src/mqtt.ts` — extend `handlePveCluster` signature; update import-side type and dispatch call.
- **Create** `tests/unit/hub-ingest-pve-cluster.test.ts` — unit tests for the new behavior.

No schema migration. No new files in `hub/src/`. No agent changes. No frontend changes.

---

## Task 1: Failing test for the seeding behavior

**Files:**
- Create: `tests/unit/hub-ingest-pve-cluster.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/unit/hub-ingest-pve-cluster.test.ts` with the following content:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createTestDb } = require('../helpers/db');
const { ingestPveCluster, upsertHost } = require('../../hub/src/ingest');

interface HostRow { host_id: string; proxmox_cluster_id: string | null }
interface ClusterRow { cluster_name: string; quorate: number; total_nodes: number; online_nodes: number }

function status(clusterName: string, overrides: Partial<{ quorate: number; totalNodes: number; onlineNodes: number }> = {}) {
  return {
    clusterName,
    quorate: overrides.quorate ?? 1,
    totalNodes: overrides.totalNodes ?? 3,
    onlineNodes: overrides.onlineNodes ?? 3,
  };
}

describe('ingestPveCluster', () => {
  let db: any;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('seeds hosts.proxmox_cluster_id for the publishing PVE node', () => {
    upsertHost(db, 'proxmox-01');
    ingestPveCluster(db, 'proxmox-01', status('homelab'));
    const cluster = db.prepare('SELECT * FROM pve_cluster_status WHERE cluster_name = ?').get('homelab') as ClusterRow | undefined;
    assert.ok(cluster, 'pve_cluster_status row exists');
    assert.equal(cluster!.quorate, 1);
    const host = db.prepare('SELECT host_id, proxmox_cluster_id FROM hosts WHERE host_id = ?').get('proxmox-01') as HostRow | undefined;
    assert.equal(host?.proxmox_cluster_id, 'homelab');
  });

  it('updates host cluster_id when the cluster is renamed', () => {
    upsertHost(db, 'proxmox-01');
    ingestPveCluster(db, 'proxmox-01', status('old-name'));
    ingestPveCluster(db, 'proxmox-01', status('new-name'));
    const host = db.prepare('SELECT proxmox_cluster_id FROM hosts WHERE host_id = ?').get('proxmox-01') as HostRow | undefined;
    assert.equal(host?.proxmox_cluster_id, 'new-name');
  });

  it('is a silent no-op when the host row does not yet exist', () => {
    ingestPveCluster(db, 'unknown-node', status('homelab'));
    const cluster = db.prepare('SELECT * FROM pve_cluster_status WHERE cluster_name = ?').get('homelab') as ClusterRow | undefined;
    assert.ok(cluster, 'pve_cluster_status row written even without host row');
    const host = db.prepare('SELECT host_id FROM hosts WHERE host_id = ?').get('unknown-node') as HostRow | undefined;
    assert.equal(host, undefined, 'no host row created by ingestPveCluster');
  });

  it('does not modify other host rows', () => {
    upsertHost(db, 'proxmox-01');
    upsertHost(db, 'other-host');
    ingestPveCluster(db, 'proxmox-01', status('homelab'));
    const other = db.prepare('SELECT proxmox_cluster_id FROM hosts WHERE host_id = ?').get('other-host') as HostRow | undefined;
    assert.equal(other?.proxmox_cluster_id, null);
  });
});
```

> Note: `upsertHost` is the existing helper exported from `hub/src/ingest.ts`. Real signature: `upsertHost(db, hostId, agentVersion?, runtimeType?, hostGroup?, hostLabels?)`. The tests above use the two-arg form (`hostId` only) which inserts a minimal `hosts` row with `runtime_type='docker'` defaults — sufficient for these tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/unit/hub-ingest-pve-cluster.test.ts`

Expected: FAIL. The two-arg call signature `ingestPveCluster(db, status)` is current, so the three-arg call in the test will either crash on `status.clusterName` being undefined, or pass through to a UPSERT that succeeds — but the `hosts.proxmox_cluster_id` assertion fails because nothing populates that column today.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/unit/hub-ingest-pve-cluster.test.ts
git commit -m "test: failing tests for PVE cluster_id seeding"
```

---

## Task 2: Extend `ingestPveCluster` to seed `hosts.proxmox_cluster_id`

**Files:**
- Modify: `hub/src/ingest.ts:850-860` (the `ingestPveCluster` function body)
- Modify: `hub/src/ingest.ts:937` (the `module.exports` block — type assertion only, no functional change)

- [ ] **Step 1: Replace the `ingestPveCluster` function body**

In `hub/src/ingest.ts`, replace the entire current implementation (lines ~850–860):

```ts
function ingestPveCluster(db: Database.Database, status: PveClusterRecord): void {
  db.prepare(`
    INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes, observed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cluster_name) DO UPDATE SET
      quorate      = excluded.quorate,
      total_nodes  = excluded.total_nodes,
      online_nodes = excluded.online_nodes,
      observed_at  = excluded.observed_at
  `).run(status.clusterName, status.quorate, status.totalNodes, status.onlineNodes);
}
```

with:

```ts
function ingestPveCluster(db: Database.Database, hostId: string, status: PveClusterRecord): void {
  const upsertCluster = db.prepare(`
    INSERT INTO pve_cluster_status (cluster_name, quorate, total_nodes, online_nodes, observed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cluster_name) DO UPDATE SET
      quorate      = excluded.quorate,
      total_nodes  = excluded.total_nodes,
      online_nodes = excluded.online_nodes,
      observed_at  = excluded.observed_at
  `);
  const seedHostClusterId = db.prepare(`
    UPDATE hosts SET proxmox_cluster_id = ? WHERE host_id = ?
  `);
  db.transaction(() => {
    upsertCluster.run(status.clusterName, status.quorate, status.totalNodes, status.onlineNodes);
    seedHostClusterId.run(status.clusterName, hostId);
  })();
}
```

- [ ] **Step 2: No change needed to `module.exports`**

The `module.exports` block at the bottom of `hub/src/ingest.ts` exports the function reference itself; the runtime signature is whatever the function definition has. No edit needed.

> If a TypeScript type assertion in the consuming `mqtt.ts` (next task) describes the function shape, update it there.

- [ ] **Step 3: Run the new test — should still fail**

Run: `npx tsx --test tests/unit/hub-ingest-pve-cluster.test.ts`

Expected: PASS. The function now writes both rows. (If the test still fails because of the call-site signature in `mqtt.ts`, that is fine — the unit test imports `ingestPveCluster` directly and does not touch `mqtt.ts`.)

- [ ] **Step 4: Run the full test suite to catch any regressions**

Run: `npm test`

Expected: PASS. Any failure is likely a call-site that has not yet been updated. The only known production call site is `hub/src/mqtt.ts:871`, addressed in Task 3.

> If `npm test` fails because TypeScript type-checking flags a call-site arity mismatch in `hub/src/mqtt.ts:871`, do **not** patch it here. Stop and proceed to Task 3 — the change belongs there.

- [ ] **Step 5: Commit**

```bash
git add hub/src/ingest.ts
git commit -m "feat(hub): ingestPveCluster seeds hosts.proxmox_cluster_id"
```

---

## Task 3: Thread `hostId` through `handlePveCluster`

**Files:**
- Modify: `hub/src/mqtt.ts:28` (import-side type assertion for `ingestPveCluster`)
- Modify: `hub/src/mqtt.ts:340` (dispatch call site)
- Modify: `hub/src/mqtt.ts:870-878` (the `handlePveCluster` function definition)

- [ ] **Step 1: Update the import-side type for `ingestPveCluster`**

In `hub/src/mqtt.ts:28`, change:

```ts
ingestPveCluster: (db: Database.Database, status: any) => void;
```

to:

```ts
ingestPveCluster: (db: Database.Database, hostId: string, status: any) => void;
```

- [ ] **Step 2: Replace the `handlePveCluster` function**

Replace the current `handlePveCluster` at `hub/src/mqtt.ts:870`:

```ts
function handlePveCluster(db: Database.Database, payload: PveClusterPayload): void {
  ingestPveCluster(db, {
    clusterName: payload.cluster_name,
    quorate: payload.quorate,
    totalNodes: payload.total_nodes,
    onlineNodes: payload.online_nodes,
  });
  logger.info('mqtt', `Ingested PVE cluster ${payload.cluster_name} quorate=${payload.quorate}`);
}
```

with:

```ts
function handlePveCluster(db: Database.Database, hostId: string, payload: PveClusterPayload): void {
  ingestPveCluster(db, hostId, {
    clusterName: payload.cluster_name,
    quorate: payload.quorate,
    totalNodes: payload.total_nodes,
    onlineNodes: payload.online_nodes,
  });
  logger.info('mqtt', `Ingested PVE cluster ${payload.cluster_name} quorate=${payload.quorate}`);
}
```

- [ ] **Step 3: Update the dispatch site**

At `hub/src/mqtt.ts:340`, change:

```ts
} else if (type === 'pve-cluster') {
  handlePveCluster(db, payload);
}
```

to:

```ts
} else if (type === 'pve-cluster') {
  handlePveCluster(db, hostId, payload);
}
```

`hostId` is already in scope at this dispatch site (extracted from the topic earlier in the handler — see `hub/src/mqtt.ts` around the topic-parse block above line 320).

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`

Expected: PASS with no errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: PASS. All existing tests still pass; the new `hub-ingest-pve-cluster.test.ts` passes.

- [ ] **Step 6: Commit**

```bash
git add hub/src/mqtt.ts
git commit -m "feat(hub): handlePveCluster forwards hostId to ingest"
```

---

## Task 4: Manual verification on vdev (post-deploy smoke test)

This task is for the human operator after the implementation lands and is deployed to the vdev VM via the standard deploy loop (see memory: "insightd VM ops").

- [ ] **Step 1: Deploy hub to vdev**

Use the standard vdev deploy loop (the operator knows the recipe). Confirm the hub container restarts cleanly.

- [ ] **Step 2: Wait one PVE collection cycle (~30s)**

Wait for the proxmox-01 PVE agent to publish at least one `pve-cluster` MQTT message after the new hub starts.

- [ ] **Step 3: Inspect the `hosts` table for the PVE node**

On the vdev VM, use the standard alpine+sqlite recipe (memory: "insightd VM ops") to run:

```sql
SELECT host_id, proxmox_cluster_id FROM hosts WHERE host_id = 'proxmox-01';
```

Expected: one row with `proxmox_cluster_id` populated with the actual PVE cluster name (whatever corosync reports — *not* null).

- [ ] **Step 4: Restart an in-guest agent and verify the linked guest gets the cluster_id**

Restart an in-guest agent (e.g., the n8n VM at 10.0.0.125 — see memory). Wait one cycle. Then:

```sql
SELECT host_id, proxmox_node, proxmox_vmid, proxmox_cluster_id FROM hosts WHERE proxmox_vmid IS NOT NULL;
```

Expected: every row that has a non-null `proxmox_vmid` (i.e., is linked) has the same `proxmox_cluster_id` as the PVE node.

- [ ] **Step 5: Confirm UI is unaffected**

Open the hub UI. Confirm the host detail page for the n8n VM still shows the hypervisor-link card (PR #249 work). No regression.

- [ ] **Step 6: Tag and release**

If verification passes, the operator can tag a hub release per the standard `hub-v*` tagging recipe. (No agent changes — no `agent-v*` tag needed.)

---

## Self-Review Notes

- **Spec coverage:** Both writes (pve_cluster_status UPSERT + hosts UPDATE) covered in Task 2 inside one transaction. Signature change propagated through Task 3. Edge cases from spec (no host row, cluster rename, other-host isolation) all covered in Task 1 tests. Standalone-PVE case is implicit — agent never publishes, code path never runs.
- **No backfill:** intentionally omitted per spec non-goal. Already-linked guests stay null until next identity-hint message naturally re-resolves them.
- **No matcher change:** the matcher already reads via `LEFT JOIN hosts`. Once the seed lands, future matches pick up cluster_id with zero matcher edits.
