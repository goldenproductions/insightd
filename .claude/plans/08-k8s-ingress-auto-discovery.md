# Plan 08: Ingress auto-discovery → HTTP endpoint monitor

Item #6 from the 2026-04-23 k8s roadmap. Items 1–5 shipped as PRs #188–#192. Ingresses are the **last** medium-impact item; items 7–9 are all "would be nice". After this PR, consider cutting `hub-v0.20.0` / `agent-v0.16.0` to bundle the six untagged k8s features (#188, #189, #190, #191, #192, and this one).

The original blurb said *"hub fetches from cluster"* — that misspoke. The hub holds no k8s credentials. The realistic shape is **agent leader → MQTT → hub**, mirroring PV/PVC/events.

## 1. Recon — what's there, what's missing

### Leader election (already exists, reuse 1:1)

`agent/src/runtime/k8s-lease.ts` implements `createLeaderElector({ client, namespace, leaseName, identity })`. `agent/src/scheduler.ts:147–164` already wires up **one** `clusterPublisher` on the `insightd-pv-publisher` lease and gates PV + PVC + Events publishing on `clusterPublisher.leader.isLeader()`. PR #189 (events) reused the same lease — convention is firmly "**one lease, many cluster-scoped resources**". Ingresses join that gate.

### MQTT topic shape

Per-host topics use `insightd/<hostId>/<resource>`. **Cluster-scoped topics use a sentinel:** `insightd/_cluster_<clusterId>/<resource>`. Hub still subscribes via `insightd/+/<resource>`, then unwraps `_cluster_<id>` from `parts[1]` in the message handler (`hub/src/mqtt.ts:214–223`).

New topic: `insightd/_cluster_<clusterId>/ingresses`. New hub subscription: `insightd/+/ingresses`.

### RBAC

`agent/k8s/rbac.yaml` ClusterRole `insightd-agent` already covers pods, nodes, replicasets, persistentvolumes, persistentvolumeclaims, events. **Add:** `apiGroups: ["networking.k8s.io"]`, `resources: ["ingresses"]`, `verbs: ["get", "list"]`. Skip `extensions/v1beta1` (removed in k8s 1.22; k3s ships 1.27+).

### HTTP endpoint monitor (already exists)

`hub/src/db/schema.ts:251` defines `http_endpoints`: `id, name, url, method, expected_status, interval_seconds, timeout_ms, headers, enabled, created_at, updated_at`. `http_checks` is FK'd `ON DELETE CASCADE`. Polling cron is every minute (`hub/src/scheduler.ts:75`); checker re-reads each endpoint's `interval_seconds` and skips ones whose last check is too recent.

`createEndpoint` (`hub/src/http-monitor/queries.ts:86`) takes `{ name, url, method?, expectedStatus?, intervalSeconds?, timeoutMs?, headers?, enabled? }`. **No source-tag column, no notion of auto-discovered.** Today every endpoint is user-created via `EndpointFormPage.tsx`.

### `cluster_id` derivation

`getClusterIdForHost` at `hub/src/web/queries.ts:1820`. Reuse on hub side.

### Schema status

`SCHEMA_VERSION = 36` in both `hub/src/db/schema.ts:4` and `src/db/schema.ts:4`. PR #192 (resource limits) was the v36 bump. This plan is **v37**.

## 2. Scope proposal

### Principle

Auto-discovery answers *"what HTTP services does my cluster expose?"* without making the user type a URL — but it should **never** create noise. A fresh k3s install drops 10+ ingresses (traefik dashboard, longhorn, namespace UIs); silently spinning up 60s probes on first connect is a bad first impression.

### Lifecycle decision: B (explicit promotion)

**Option A** — auto-CREATE `http_endpoints` on discovery. Zero clicks, max noise; "delete cascade for orphans" is subtle.
**Option B** — surface ingresses as a "discovered" list, user clicks "Monitor this". Clean, zero noise, explicit intent.
**Option C** — hybrid with auto-monitor toggle. Two surfaces, two flags.

**Pick B.** Matches Andreas's homelab feel ("show me what's there, I'll choose what to watch"). Inventory row = "this exists"; `http_endpoints` row = "I'm polling this"; loosely coupled by an optional FK.

### Impact-ranked surfaces

| # | Surface | Effort | MVP? |
|---|---|---|---|
| A | Agent: leader-elected ingress collector + MQTT publisher | Small | **YES** |
| B | Hub: `k8s_ingresses` inventory + ingest | Small | **YES** |
| C | "Discovered" section on Endpoints page (one-click "Monitor") | Small | **YES** |
| D | `source_ingress_id` FK on `http_endpoints` | Tiny | **YES** |
| E | Per-host k8s tab listing cluster ingresses | Small | defer |
| F | Auto-monitor-everything Settings toggle | Small | defer |
| G | Per-path probing for multi-path ingresses | Medium | defer |
| H | Ingress class filter | Tiny | defer |
| I | TLS cert expiry surfaced from ingresses | Medium | defer (separate roadmap) |
| J | Custom method/headers on promoted endpoints | Tiny | defer (already editable) |

### MVP (one PR)

**"Inventory ingresses cluster-wide; let me promote any of them to an HTTP endpoint with one click."**

- Agent: `collectIngresses` + `publishIngresses` on existing lease. RBAC bump.
- Hub: schema v37, `k8s_ingresses` table, `ingestIngresses`, MQTT subscription.
- Hub: `http_endpoints.source_ingress_id` (nullable FK).
- API: `POST /api/endpoints/from-ingress/:ingressId`.
- UI: "Discovered ingresses" section on Endpoints page above existing list. One row per ingress, monitor button (or "monitored" pill if promoted).

## 3. Schema — v37 migration

```sql
-- Inventory keyed by (cluster_id, namespace, name) — stable across recreations
CREATE TABLE IF NOT EXISTS k8s_ingresses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id      TEXT NOT NULL,
  namespace       TEXT NOT NULL,
  name            TEXT NOT NULL,
  ingress_class   TEXT,
  hosts           TEXT NOT NULL,    -- JSON array
  paths           TEXT NOT NULL,    -- JSON array of {host, path, pathType, serviceName, servicePort}
  tls_hosts       TEXT,             -- JSON array (subset of hosts in spec.tls[].hosts[])
  external_ip     TEXT,
  created_at      TEXT,
  labels          TEXT,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at      TEXT,
  UNIQUE(cluster_id, namespace, name)
);

CREATE INDEX IF NOT EXISTS idx_k8s_ingresses_cluster ON k8s_ingresses (cluster_id, observed_at DESC);

ALTER TABLE http_endpoints ADD COLUMN source_ingress_id INTEGER
  REFERENCES k8s_ingresses(id) ON DELETE SET NULL;
```

### Why upsert (not snapshot)

PV/PVC use snapshot model (insert per cycle, MAX(collected_at)). Ingresses are different: **identity is the unit of interest** (so promotion survives every cycle), cardinality is low (~10s per cluster). Use the registry-style upsert: `INSERT … ON CONFLICT(cluster_id, namespace, name) DO UPDATE SET …, removed_at = NULL`. After upserting the batch, stamp `removed_at = batch_start_time` on rows in this cluster_id with `observed_at < batch_start_time`. Mirrors `containers` registry from PR #150.

This makes `source_ingress_id` stable across publisher cycles.

### Standalone mirror

`src/db/schema.ts` runs the same `CREATE TABLE IF NOT EXISTS k8s_ingresses` and the `ALTER TABLE http_endpoints ADD COLUMN` — harmless on Docker (always NULL). Both files bump `SCHEMA_VERSION = 37`.

## 4. Step-by-step plan (MVP)

### Agent

**`agent/src/runtime/kubernetes.ts`** — `K8sIngress` types covering `metadata`, `spec.ingressClassName`, `spec.rules[].{host, http.paths[].{path, pathType, backend.service}}`, `spec.tls[].hosts[]`, `status.loadBalancer.ingress[]`. Add `listIngresses(): Promise<K8sList<K8sIngress>>` against `/apis/networking.k8s.io/v1/ingresses` (cluster-wide, no namespace path). Mirrors `listPvs`.

**`agent/src/collectors/k8s-cluster.ts`** — `IngressInfo` interface (hostnames, paths, tlsHosts, externalIp, ingressClass, labels, createdAt, namespace, name). `mapIngress(ing)` returns null if no rule has a host; flattens `rules[]` into `paths[]` of `{host, path, pathType, serviceName, servicePort}`. `collectIngresses(client)`.

**`agent/src/scheduler.ts`** — inside the leader gate (after the events publish): `const ingresses = await safeCollect('ingresses', () => collectIngresses(clusterPublisher!.client));` then `await safeCollect('mqtt-ingresses', () => publishIngresses(clusterPublisher!.clusterId, config.hostId, ingresses));`. **No new lease, no new env var.**

**`agent/src/mqtt.ts`** — `publishIngresses(clusterId, publisherHostId, ingresses)` mirroring `publishPvcs`. Topic: `insightd/_cluster_${clusterId}/ingresses`. Payload `{version: 1, items: [...]}`.

**`agent/k8s/rbac.yaml`** — one rule on ClusterRole: `apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list"]`.

### Hub

**`hub/src/db/schema.ts`** + **`src/db/schema.ts`** — bump `SCHEMA_VERSION` to 37. Add `k8s_ingresses` CREATE + index in bootstrap. Add `ALTER TABLE http_endpoints ADD COLUMN source_ingress_id …`. Add `if (fromVersion < 37) { … }` migration block (CREATE IF NOT EXISTS for `k8s_ingresses`, try/catch ALTER for the FK column).

**`hub/src/ingest.ts`** — `ingestIngresses(db, clusterId, ingresses)`: in a transaction, capture `batchAt`, upsert each by `(cluster_id, namespace, name)` setting `observed_at = batchAt, removed_at = NULL`, then stamp `removed_at` on cluster's rows with `observed_at < batchAt`.

**`hub/src/mqtt.ts`** — subscribe `insightd/+/ingresses`. In router: `if (type === 'ingresses') { handleIngresses(db, clusterId, payload); return; }`.

**`hub/src/http-monitor/queries.ts`**
- `getDiscoveredIngresses(db, clusterId?)` — left-join `k8s_ingresses` to `http_endpoints` on `source_ingress_id`; only `removed_at IS NULL`.
- `createEndpointFromIngress(db, ingressId, options?)`:
  - name = `<namespace>/<host>`; collision-suffix `-2`, `-3`. Use first `host`.
  - URL: `https://<host>` if host appears in `tls_hosts`, else `http://<host>`. Append first non-`/` path.
  - Defaults: GET, 200, 60s, 10000ms, enabled=1, **`source_ingress_id` set**.

**`hub/src/web/handlers.ts`**
- `handleGetDiscoveredIngresses` — GET `/api/ingresses`.
- `handleCreateEndpointFromIngress` — POST `/api/endpoints/from-ingress/:ingressId`. 409 if already monitored.

### Frontend

**`hub/src/web/frontend/src/types/api.ts`** — `DiscoveredIngress`: `{ id, clusterId, namespace, name, hosts, paths, tlsHosts, ingressClass, monitoredEndpointId }`.

**`hub/src/web/frontend/src/pages/EndpointsPage.tsx`** — `useQuery({ queryKey: ['ingresses', 'discovered'], … })`. New "Discovered ingresses" section above existing list, only renders when `discovered.length > 0`. Row: namespace pill, primary host, default URL preview, monitor button (or "monitored" pill linking to endpoint detail). Click → `apiAuth('POST', '/endpoints/from-ingress/' + id, …, token)`, invalidate both queries, navigate to new endpoint.

### Tests

- `tests/unit/agent-ingress-mapper.test.ts` — happy path, missing host (skip), multi-path, TLS hosts.
- `tests/unit/hub-ingest-ingresses.test.ts` — upsert idempotent; `removed_at` stamped on disappearance; cluster_a vs cluster_b isolation.
- `tests/unit/hub-create-endpoint-from-ingress.test.ts` — tls→https, no-tls→http, first non-`/` path appended, duplicate name → `-2`, 409 when already monitored, `source_ingress_id` populated.
- `tests/unit/hub-schema-v37.test.ts` — bootstrap fresh + migration from v36 idempotent.

~15 new tests. Existing 917 stay green.

## 5. Explicit deferrals

- TLS cert expiry from ingresses (separate roadmap).
- Per-path probing for multi-path ingresses (v1 picks first non-`/`).
- Custom method/headers/expected_status on promoted (already editable on EndpointFormPage).
- Ingress class filter.
- "Auto-monitor everything" Settings toggle.
- Per-host k8s tab — ingresses are cluster-scoped, not node-scoped.
- Cascade-on-delete UX flourish — when ingress disappears, endpoint keeps polling; user decides.
- Internal services without ingresses (ClusterIP/NodePort) — no public URL by definition.
- Watch instead of poll — same 5-min cadence as PV/events; not worth the complexity.

## 6. Design decisions (locked 2026-04-25)

1. **Default scheme:** `https://` when host appears in `spec.tls[].hosts[]`, else `http://`.
2. **Default name:** `<namespace>/<host>`. Collisions get `-2`, `-3` suffix.
3. **Polling interval:** 60s (existing default).
4. **When source ingress disappears:** keep polling. Stamp `removed_at` on the inventory row only; the `http_endpoints` row continues unchanged. Defer "source gone" badge to v2.
5. **Re-promotion after delete-then-recreate:** automatic — `(cluster_id, namespace, name)` upsert key reuses the same `k8s_ingresses.id`, the `source_ingress_id` link stays intact, `removed_at` clears.
6. **One-click "stop monitoring" on the discovered list:** deferred. Existing endpoint-detail delete flow handles it.
7. **Ingress rule with no `host`:** drop at mapper level — not actionable as URL.
8. **Multiple hosts on one ingress:** one inventory row, `hosts` JSON array; promotion picks the first host. Additional hosts cloned via existing EndpointForm.

## 7. Original open questions (kept for traceability)

1. **Default scheme.** Recommendation: **https when host appears in `spec.tls[].hosts[]`, else http.** Detects most homelab cases without per-ingress config.

2. **Default name format.** Recommendation: `<namespace>/<host>` (matches PR #192 namespace convention). Andreas's case: `monitoring/grafana.local.example`.

3. **Default polling interval for promoted endpoints.** Recommendation: **60s** (existing default).

4. **Behavior when source ingress disappears.** Recommendation: **`source_ingress_id` stays set; `removed_at` is stamped on the inventory row but the endpoint keeps polling.** User decides via existing delete flow. Surface a "source no longer present" badge in v2.

5. **Re-promotion after delete-then-recreate.** With (cluster_id, namespace, name) upsert key, the same `k8s_ingresses.id` is reused, the link stays intact, `removed_at` clears automatically. **No user action needed.** Confirm desired?

6. **One-click "stop monitoring" on the discovered list.** Recommendation: **defer** — destructive action on a cluster overview is a footgun; existing endpoint-detail delete flow exists.

7. **Ingress rule with no `host`.** Recommendation: drop at mapper level — not actionable as URL.

8. **Multiple hosts on one ingress.** Recommendation: one inventory row per ingress with `hosts` JSON array; promotion picks first host. Clones for additional hosts via existing form.

## Critical files

- `/home/andreas/insightd/agent/src/runtime/kubernetes.ts`
- `/home/andreas/insightd/agent/src/collectors/k8s-cluster.ts`
- `/home/andreas/insightd/agent/src/scheduler.ts`
- `/home/andreas/insightd/agent/src/mqtt.ts`
- `/home/andreas/insightd/agent/k8s/rbac.yaml`
- `/home/andreas/insightd/hub/src/db/schema.ts`
- `/home/andreas/insightd/src/db/schema.ts`
- `/home/andreas/insightd/hub/src/ingest.ts`
- `/home/andreas/insightd/hub/src/mqtt.ts`
- `/home/andreas/insightd/hub/src/http-monitor/queries.ts`
- `/home/andreas/insightd/hub/src/web/handlers.ts`
- `/home/andreas/insightd/hub/src/web/frontend/src/pages/EndpointsPage.tsx`
