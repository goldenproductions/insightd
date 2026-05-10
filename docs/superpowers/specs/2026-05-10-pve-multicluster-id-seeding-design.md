# PVE Multi-Cluster `cluster_id` Seeding

**Status:** Design approved (2026-05-10), pending implementation plan.

**Follow-up to:** [2026-05-09 Proxmox Guest ↔ Host Auto-Correlation](./2026-05-09-proxmox-guest-host-correlation-design.md) (PR #249), the only remaining v2 item from that work.

## Problem

The identity matcher in `hub/src/identity/matcher.ts` propagates `cluster_id` from the PVE node host's `hosts.proxmox_cluster_id` column to each linked in-guest agent host. Today nothing populates that column for PVE node hosts, so every linked guest gets `cluster_id = null`.

Consequence: in a single-cluster homelab (the current state), this is cosmetic — the linkage still works because the matcher disambiguates on UUID (qemu) or hostname/MAC (lxc). But a second PVE cluster with overlapping VMIDs would cause the matcher to over-match: a guest in cluster A could resolve to a guest in cluster B, since neither side has a real `cluster_id` to scope against.

## Goal

Seed `hosts.proxmox_cluster_id` on each PVE node host with the cluster name reported by that node's `pve-cluster` MQTT message. After this lands, the existing matcher's `LEFT JOIN hosts h ON h.host_id = cs.host_id` resolves a real cluster_id, and `IdentityMatch.cluster_id` propagates onto linked guests on next match.

## Non-goals

- Backfilling already-linked guest hosts. Single-cluster homelab is the current state; null cluster_id on existing links is harmless. The next identity-hint message naturally re-resolves and writes the correct cluster_id.
- Cross-cluster matcher scoping logic. The matcher already reads cluster_id; no change needed there.
- Standalone-PVE handling. Standalone agents never publish `pve-cluster` (per `agent/src/scheduler.ts:188`), so `proxmox_cluster_id` stays null and matches today's behavior.
- Schema changes. `hosts.proxmox_cluster_id` already exists (added with PR #249).
- Cluster rename / re-cluster handling beyond "next ingest cycle wins". `pve_cluster_status` is keyed on `cluster_name` and accepts whatever each node reports.

## Architecture

```
┌──────────────┐    insightd/<host>/pve-cluster    ┌────────────────────┐
│ PVE agent    │  ────────────────────────────►   │ hub MQTT handler   │
│ (proxmox-01) │  { cluster_name, quorate, ... }   │ handlePveCluster() │
└──────────────┘                                   └─────────┬──────────┘
                                                             │
                                                             ▼
                                                  ┌────────────────────┐
                                                  │ ingestPveCluster() │
                                                  │  (single tx)       │
                                                  │                    │
                                                  │  1. UPSERT into    │
                                                  │     pve_cluster_   │
                                                  │     status         │
                                                  │  2. UPDATE hosts   │
                                                  │     SET proxmox_   │
                                                  │     cluster_id = ? │
                                                  │     WHERE host_id  │
                                                  │     = ?            │
                                                  └────────────────────┘
```

**Principle:** the two writes derive from the same MQTT message and represent one atomic state transition for that PVE node — wrap them in `db.transaction` so a hub crash mid-write cannot leave the cluster table updated but the host row stale (or vice versa).

## Component changes

All edits in two files. No new files.

### 1. `hub/src/ingest.ts` — `ingestPveCluster`

Extend the function signature to take `hostId` and wrap both writes in a single transaction.

**Before** (current `hub/src/ingest.ts:850–860`):

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

**After:**

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

Also update the type assertion in `module.exports` at `hub/src/ingest.ts:937` and the import-side type in `hub/src/mqtt.ts:28`.

### 2. `hub/src/mqtt.ts` — `handlePveCluster`

Take `hostId` and forward it.

**Before** (`hub/src/mqtt.ts:870`):

```ts
function handlePveCluster(db: Database.Database, payload: PveClusterPayload): void {
  ingestPveCluster(db, { ... });
  ...
}
```

**After:**

```ts
function handlePveCluster(db: Database.Database, hostId: string, payload: PveClusterPayload): void {
  ingestPveCluster(db, hostId, { ... });
  ...
}
```

Dispatch site (`hub/src/mqtt.ts:340`):

```ts
} else if (type === 'pve-cluster') {
  handlePveCluster(db, hostId, payload);
}
```

## Edge cases

| Case | Behavior |
|---|---|
| Standalone PVE (no cluster) | Agent's `collectClusterStatus` returns null, `publishPveCluster` is skipped, `handlePveCluster` never runs. `hosts.proxmox_cluster_id` stays null. Matches today. |
| PVE node host row not yet upserted when first `pve-cluster` arrives | `UPDATE … WHERE host_id = ?` matches zero rows. Silent no-op. Next cycle (after the node's first `collection` upserts the host row) will succeed. |
| Cluster renamed in PVE | New `cluster_name` from corosync. New row in `pve_cluster_status` (PK is `cluster_name`, old row orphans — pre-existing behavior, out of scope). PVE node host's `proxmox_cluster_id` overwritten with new name on next cycle. Linked guests keep stale name until next identity-hint message re-resolves them. |
| Multiple PVE nodes in same cluster | Each independently UPDATEs its own `hosts` row to the same `cluster_name`. Idempotent. |
| PVE node moved to a different cluster | Next `pve-cluster` cycle reports new `cluster_name`. Host's `proxmox_cluster_id` overwritten. Linked guests catch up on next identity-hint. |
| Already-linked guests with null `cluster_id` | Stay null until next identity-hint MQTT message fires the matcher. Acceptable per non-goal. |

## Testing

One new unit test in `tests/unit/ingest-pve-cluster.test.ts`:

- **Seed → assert host updated.** Insert a row into `hosts` with `host_id='proxmox-01'`. Call `ingestPveCluster(db, 'proxmox-01', { clusterName: 'homelab', quorate: 1, totalNodes: 3, onlineNodes: 3 })`. Assert `pve_cluster_status` row exists AND `hosts.proxmox_cluster_id = 'homelab'` for `proxmox-01`.
- **Update on cluster rename.** Run twice with different `clusterName`. Assert the second value wins.
- **No host row → silent no-op.** Call without inserting `hosts` row first. Assert no error, no `hosts` row created.
- **Other hosts untouched.** Insert two `hosts` rows; call for one. Assert the other's `proxmox_cluster_id` stays null.

Existing matcher tests already cover the `cluster_id` propagation path (since the matcher reads it via JOIN); no changes needed there.

**Manual UX test on vdev VM after deploy:**

1. Deploy to vdev. Confirm `proxmox-01` PVE agent publishes `pve-cluster`.
2. `sqlite3` query: `SELECT host_id, proxmox_cluster_id FROM hosts WHERE host_id='proxmox-01';` — expect cluster name, not null.
3. Restart an in-guest agent (e.g. n8n VM). Confirm its identity hint fires the matcher, then query `hosts` for the in-guest agent's host_id — expect `proxmox_cluster_id` populated with same cluster name.

## Migration & rollout

- No schema change. Column exists.
- Backwards compatible: old PVE agents publish the same `pve-cluster` payload; the new hostId comes from the MQTT topic, not the payload. Mixed-version environments work.
- No backfill. Existing links naturally re-resolve on next identity-hint cycle.

## Surface summary

- 2 files touched (`hub/src/ingest.ts`, `hub/src/mqtt.ts`)
- 1 new unit test file (~4 cases)
- 0 schema migrations
- 0 new MQTT topics
- 0 API or UI changes
