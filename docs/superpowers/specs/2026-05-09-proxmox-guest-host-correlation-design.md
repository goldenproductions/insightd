# Proxmox Guest ↔ In-Guest Host Auto-Correlation

**Status:** Design approved (2026-05-09), pending implementation plan.

## Problem

When a user runs the insightd Proxmox VE agent on their hypervisor *and* installs in-guest insightd agents inside their VMs/CTs, every guest appears as two unrelated entities in the UI:

1. A "container" row reported by the PVE agent (CPU/memory from the hypervisor's view, snapshot/backup state, VMID).
2. A "host" entry reported by the in-guest agent (per-process metrics, container inventory inside the VM, host disk usage, etc.).

There is no automatic linkage between them. A manual identity-bridge mechanism exists (`INSIGHTD_PROXMOX_NODE` + `INSIGHTD_PROXMOX_VMID` env vars on the in-guest agent), but it is tedious, undiscoverable, and error-prone — most users never set it.

The user wants insightd to figure this out automatically and present a single unified view per guest.

## Goals

- Zero-config correlation: in-guest agent and PVE agent automatically establish the link with no operator setup.
- Unified UX: clicking a PVE-guest container row in the UI navigates directly to the in-guest agent's host-detail page, with PVE-side data (VMID, snapshots, backups) shown as a section on that page.
- Safe fallback: when a guest is stopped (no in-guest agent reporting), the existing PVE-only view continues to work.
- Both qemu and LXC supported in v1.

## Non-goals

- Cross-cluster VMID disambiguation beyond what UUIDs / MAC addresses give us. Operator is responsible for unique LXC hostnames within a cluster.
- Replacing or migrating the existing manual env-var bridge. It stays as an advanced override.
- Auto-installing the in-guest agent inside discovered guests. Out of scope.
- Linking arbitrary non-PVE hypervisors (KVM-without-PVE, ESXi, Hyper-V).

## Architecture

```
┌─────────────────────┐         identity-hint MQTT       ┌──────────────────┐
│ in-guest agent      │  ────────────────────────────►   │ hub identity     │
│  - detect virt type │  insightd/<host>/identity-hint   │ matcher          │
│  - read uuid/host   │  { virt_type, system_uuid,       │  joins hint vs   │
│  - publish hint     │    hostname, primary_mac }       │  PVE inventory   │
└─────────────────────┘                                  └────────┬─────────┘
                                                                  │
                                              writes on match     │
                                                                  ▼
                                                    ┌─────────────────────────┐
                                                    │ hosts table             │
                                                    │  + proxmox_cluster_id   │
                                                    │  + proxmox_node         │
                                                    │  + proxmox_vmid         │
                                                    │  + proxmox_guest_type   │
                                                    └─────────────────────────┘
```

**Principles:**
- Agent only collects and publishes hints. It has no knowledge of PVE topology.
- Hub does all matching. Idempotent: same hint always resolves to the same `(cluster_id, node, vmid)` or `null`.
- Match runs on every identity-hint message and on every PVE inventory update. No background cron.
- Link is persisted to the `hosts` table, so UI reads are zero-cost.

## Component design

### 1. Agent — identity hint collector

**New file:** `agent/src/collectors/identity-hint.ts`

```ts
export type IdentityHint = {
  virt_type: 'qemu' | 'lxc' | 'bare';
  system_uuid: string | null;   // qemu only — from /sys/class/dmi/id/product_uuid
  hostname: string;             // os.hostname()
  primary_mac: string | null;   // first non-loopback non-zero MAC from os.networkInterfaces()
};

export function collectIdentityHint(): IdentityHint;
```

**Detection sequence:**

1. Read `/sys/class/dmi/id/sys_vendor`. If `"QEMU"` → `virt_type='qemu'`, then read `/sys/class/dmi/id/product_uuid` for `system_uuid`.
2. Else read `/proc/1/environ`. If it contains `container=lxc`, OR `/proc/self/cgroup` matches `lxc.payload.<vmid>` → `virt_type='lxc'`.
3. Else → `virt_type='bare'`.
4. Always populate `hostname` (via `os.hostname()`) and `primary_mac` (via `os.networkInterfaces()`, picking first non-internal IPv4/IPv6 NIC with a non-zero MAC).

**Publishing:**
- Topic: `insightd/<host_id>/identity-hint`
- Retained MQTT message (so the hub picks it up after restart without waiting for the next cycle).
- Published once on agent startup after MQTT connect, then on change (cheap diff against in-memory cache; hostname/MAC churn is rare).
- Skipped entirely when `virt_type='bare'` — no point hinting.

**Wired into:**
- `agent/src/index.ts` — invoke after MQTT connect, before scheduler start.
- `agent/src/scheduler.ts` — re-publish if hint changes between collection cycles.

**Manual override compatibility:** if `INSIGHTD_PROXMOX_NODE` and `INSIGHTD_PROXMOX_VMID` are both set, skip identity-hint publishing entirely. The existing manual bridge label path (`scheduler.ts:201`) takes precedence. Hub-side, the MQTT subscriber is also extended so that when a host_snapshot arrives carrying the `insightd.proxmox.guest=<node>/<vmid>` label, the hub populates `hosts.proxmox_*` columns directly from the label (no matcher needed — the operator provided the vmid explicitly). This keeps the unified-host UI working for users on the manual bridge.

### 2. Hub — schema migration v51

```sql
ALTER TABLE hosts ADD COLUMN proxmox_cluster_id TEXT;
ALTER TABLE hosts ADD COLUMN proxmox_node       TEXT;
ALTER TABLE hosts ADD COLUMN proxmox_vmid       INTEGER;
ALTER TABLE hosts ADD COLUMN proxmox_guest_type TEXT;
CREATE INDEX hosts_proxmox_link
  ON hosts (proxmox_cluster_id, proxmox_vmid)
  WHERE proxmox_vmid IS NOT NULL;

ALTER TABLE container_snapshots ADD COLUMN guest_uuid        TEXT;
ALTER TABLE container_snapshots ADD COLUMN guest_primary_mac TEXT;
```

All columns nullable; bare-metal hosts and non-PVE guests keep nulls. No backfill needed.

### 3. Hub — PVE collector enrichment

`agent/src/runtime/proxmox.ts` already collects `vmid`, `name`, and `type`. Extend to also collect:

- **qemu UUID:** parse `smbios1: uuid=<uuid>,...` from `/nodes/<node>/qemu/<vmid>/config` (REST mode) or `qm config <vmid>` output (pvesh mode). Surface as `guestUuid` on the runtime container info.
- **LXC primary MAC:** parse `hwaddr=<mac>` from `net0: ...` in `/nodes/<node>/lxc/<vmid>/config`. Surface as `guestPrimaryMac`.

Both fields propagate through MQTT publish into the new `container_snapshots` columns above.

### 4. Hub — identity matcher

**New file:** `hub/src/identity/matcher.ts`

```ts
export type IdentityHint = { /* same shape as agent */ };

export type IdentityMatch = {
  cluster_id: string;
  node: string;
  vmid: number;
  guest_type: 'qemu' | 'lxc';
};

export function matchIdentityHint(
  db: Database,
  hostId: string,
  hint: IdentityHint
): IdentityMatch | null;
```

**Match algorithm** (single SQL pass over current PVE guest inventory in `container_snapshots`):

1. **qemu:** `SELECT cluster_id, host_id AS node, guest_vmid, 'qemu' FROM container_snapshots WHERE guest_type='qemu' AND lower(guest_uuid)=lower(?)`. UUIDs are globally unique; >1 row is a fatal collision (log + return null).
2. **lxc:** `SELECT … WHERE guest_type='lxc' AND (lower(name)=lower(?hostname) OR primary_mac=?mac)`. If multiple rows match, prefer the row where both hostname AND mac match. If still ambiguous, return null (no link rather than wrong link).
3. **bare:** never matches; should never reach matcher (agent doesn't publish), but defensively returns null.

In-memory cache: `Map<host_id, last_match_result>` keyed by hash of `(hint payload, last PVE inventory upsert timestamp for cluster)`. If hash matches the last decision, skip the SQL. Re-publishing a retained hint with no inventory churn is a no-op.

### 5. Hub — MQTT subscriber

New handler in `hub/src/mqtt.ts` for topic `insightd/+/identity-hint`:

- Parse hint payload.
- Call `matchIdentityHint`.
- On match: `UPDATE hosts SET proxmox_cluster_id=?, proxmox_node=?, proxmox_vmid=?, proxmox_guest_type=? WHERE host_id=?`.
- On no-match for a previously-linked host: NULL the four columns.
- Log decision under `[identity]` prefix.

Also: when a PVE inventory message updates `container_snapshots`, re-run the matcher against all retained identity hints (one-shot loop bounded by number of in-guest agents — typically <30 in homelab scale).

### 6. Hub — API extensions

- `GET /api/hosts/:id` — extend response with:
  ```json
  "proxmox": {
    "cluster_id": "homelab",
    "node": "proxmox-01",
    "vmid": 108,
    "guest_type": "qemu",
    "snapshots_count": 3,
    "last_backup_at": "2026-05-08T03:14:00Z"
  } // or null
  ```
  `snapshots_count` and `last_backup_at` joined from existing `pve_guest_snapshots` and `pve_backups` tables keyed by `(host_id, vmid)`.

- `GET /api/containers/:id` (PVE-guest detail) — extend response with `linkedHostId: string | null`.

### 7. UI — `ContainerDetailPage`

`hub/src/web/frontend/src/pages/containers/ContainerDetailPage.tsx`:

- For PVE-guest container rows (where `guest_vmid != null`):
  - If `linkedHostId != null` AND guest status is `running` AND query string does NOT include `bypass_redirect=1`: `navigate(\`/hosts/${linkedHostId}\`, { replace: true })`.
  - Else render existing PVE-only container detail page.
- Replace-mode redirect so the back button does not bounce.

### 8. UI — `HostDetailPage`

`hub/src/web/frontend/src/pages/hosts/HostDetailPage.tsx`:

When `host.proxmox != null`, render new section above the existing tabs:

```
┌─ Hypervisor info ──────────────────────────────────────┐
│  PVE node:    proxmox-01      Type:  qemu              │
│  VMID:        108             Cluster: homelab         │
│                                                         │
│  Snapshots: 3      Last backup: 2026-05-08 03:14       │
│  → View on hypervisor                                   │
└─────────────────────────────────────────────────────────┘
```

- "View on hypervisor" → `/containers/<pve_container_id>?bypass_redirect=1`. Lets users see the raw hypervisor view when needed.
- Section header includes `<GlossaryHelp topic="hypervisor-link" />`.

### 9. UI — `HostsPage`

Small badge on linked hosts in the host list: `🖥️ proxmox-01:108`. Cheap visual confirmation linkage worked.

### 10. Glossary

Per the project's glossary upkeep rule, add a new entry `hypervisor-link` covering:
- What it means for a host to be linked to a PVE guest
- Why the unified view exists
- How the auto-detection works (one sentence)

## Edge cases

| Case | Behavior |
|---|---|
| Guest stopped → no in-guest agent reporting | `linkedHostId=null` on PVE container row → no redirect, existing PVE-only view shown. `hosts.proxmox_*` columns retain last-known link. |
| In-guest agent on bare-metal host (false detection) | `virt_type='bare'` → no hint published → no link. Safe default. |
| Two LXC containers with same hostname | Hostname match returns multiple rows → MAC tiebreak. If MACs also collide, return null + log `[identity] ambiguous LXC match`. |
| qemu UUID match returns >1 row | Should be impossible. Log `[identity] FATAL UUID collision`, return null. |
| Manual `INSIGHTD_PROXMOX_NODE`/`VMID` env vars set | Manual values win. Hint matcher skipped. Log `[identity] using manual override`. |
| PVE inventory not yet collected when first hint arrives | Match returns null. Hint is retained on MQTT; when PVE collector publishes its first cycle, hub re-runs match for all retained hints. |
| Hub restart loses in-memory match cache | First hint after restart re-runs match. Persistent `hosts.proxmox_*` columns mean UI is unaffected during the brief recompute window. |
| Guest migrated between PVE nodes | UUID stays same (qemu) or hostname/mac stay same (lxc). Next match writes new `proxmox_node` value. Other columns unchanged. |
| Cluster removed / PVE agent stopped | PVE inventory empties → next match finds nothing → hub NULLs `hosts.proxmox_*` for affected hosts. |
| Multiple PVE clusters with VMID overlap | qemu UUIDs globally unique → fine. LXC: operator's responsibility for unique hostnames within a cluster; if collision, no link. |

**Logging:** all match decisions log at info level under `[identity]` prefix; failures at warn. No log spam — matcher only runs on hint or PVE inventory change.

**No retries / no exponential backoff.** Match is a single SQL query; if it fails, log and move on — next hint will retry naturally.

## Testing

| File | Coverage |
|---|---|
| `tests/agent/identity-hint.test.ts` | Mock `fs.readFileSync` + `os.networkInterfaces` / `os.hostname`. Cover: qemu DMI present, lxc cgroup present, neither (bare), DMI file ENOENT, malformed UUID, no non-loopback NIC. |
| `tests/hub/identity-matcher.test.ts` | Seed in-memory DB. Cover: qemu uuid exact match, lxc hostname-only match, lxc mac-only match, lxc both-match (preferred), lxc ambiguous (no winner), no match, manual env override. |
| `tests/hub/identity-mqtt-handler.test.ts` | Drive the MQTT handler with synthetic identity-hint payloads. Verify `hosts.proxmox_*` columns get written; verify NULL-out path on inventory loss. |
| `tests/hub/api-host-detail.test.ts` (extend existing) | Verify `proxmox` block in `GET /api/hosts/:id` response. |
| `tests/integration/identity-link.test.ts` | End-to-end on in-memory hub: seed PVE guests, publish hints, assert linkages, assert deferred-match-after-inventory path. |

**Manual UX test on vdev VM after deploy:**
- Verify proxmox-01 PVE agent + an in-guest agent on n8n VM (10.0.0.125) auto-link.
- Click n8n's PVE container row → confirm redirect to host detail.
- Stop n8n VM via PVE → confirm container detail page falls back to PVE-only view.
- Restart n8n → confirm link re-establishes within one collection cycle.

## Migration & rollout

- Schema migration v51 runs on hub upgrade. Idempotent ALTER TABLE statements with try/catch (matches existing migration pattern in `hub/src/db/schema.ts`).
- New agents publish identity hints on first connect; old agents do not. Mixed-version environments work fine — old agents simply remain unlinked until upgraded.
- Manual env-var bridge users see no behavior change.

## Surface summary

- 1 new agent collector file (`agent/src/collectors/identity-hint.ts`)
- 1 new hub matcher file (`hub/src/identity/matcher.ts`)
- 1 schema migration (5 columns + 1 index across 2 tables)
- 1 new MQTT topic + handler
- 2 existing API responses extended
- 2 frontend pages get conditional sections; 1 list page gets a badge
- 1 new glossary entry
- ~15 new tests (3 unit files + 1 integration file + 1 extension)
