# Plan: Namespace as a first-class filter/group

Item #5 from the 2026-04-23 k8s roadmap. Items 1–4 shipped as PRs #188–191. Items 1–3 of the original impact list were "k8s observability gaps"; namespace is the first of the medium-tier surface polish items.

## 1. Recon — what's there, what's missing

### Data model

Namespace is **not a column** in `container_snapshots`; it's a prefix inside `container_name` (`namespace/pod/container`). One source of truth: `frontend/src/lib/containers.ts::getContainerNamespace` (splits on the first `/`).

`alert_state.target` stores `container_name` verbatim (see `hub/src/alerts/evaluator.ts:178/211/234/254/285/313/455`), so on k8s hosts an alert's target carries the namespace prefix. **Namespace is derivable from existing data — no schema change needed.**

`cluster_id` is derived lazily: `getClusterIdForHost` at `hub/src/web/queries.ts:1793` does `COALESCE(host_group_override, host_group) || 'cluster-{hostId}'`. Only persisted on genuinely cluster-scoped rows (`pv_snapshots`, `pvc_snapshots`, `k8s_events`). Container snapshots don't know a cluster — they know a host.

**Implication:** for today's single-cluster homelab, a namespace string is effectively globally unique. When a second cluster connects, we'll need cluster disambiguation — but the proposed SQL shape allows adding it later without migration.

### What already exists (do NOT duplicate)

- `hub/src/web/frontend/src/components/NamespaceFilterBar.tsx` — chip-style filter bar
- `hub/src/web/frontend/src/hooks/useNamespaceFilter.ts` — localStorage-keyed per-host, `hide` model (show all by default, toggle off the ones you don't want)
- `hub/src/web/frontend/src/lib/containers.ts` — `getContainerNamespace`, `getContainerDisplayName`, `splitContainerEntityId`
- Only consumer today: `HostOverviewTab.tsx` — filter bar above uptime timeline on k8s host detail pages

### What's missing for fleet-wide

1. **No fleet-wide containers view exists at all.** No `/containers` page, no `/api/containers` endpoint. "Fleet containers with namespace filter" would mean inventing the page first — scope creep.
2. **Alerts page** has the richest fleet surface with URL-synced filters + facet rail with counts. No namespace filter yet.
3. **Dashboard** shows hosts grouped by host_group. No namespace slice.
4. **HostsPage** has drag-and-drop host groups. Doesn't know about namespaces.
5. **StoragePage → K8sPvsTab** already shows namespace as a display column — not filterable.
6. **Per-host filter is localStorage-keyed**, not URL-driven. Inconsistent with the "URL-driven filter everywhere" convention.

### Asymmetry with Docker

Filter bar is only rendered when `isKubernetes === true`. Mirror this on fleet surfaces: if no visible alert has a namespace, hide the filter — don't render a disabled chip row.

### Stacks scaffolding

PR #174 deleted `StacksPage.tsx` / `StackDetailPage.tsx` / `StackFormPage.tsx` / `DashboardStacks.tsx` + `/stacks` + `/services` routes (redirected to `/hosts`). Namespace must feel host-adjacent, **not a resurrection of Stacks** (explicitly forbidden per project memory).

## 2. Scope proposal

### Principle

"First-class" = namespace is addressable in the URL, visible in lists, actionable as a filter on every surface where it makes sense. NOT = a dedicated navigation section. Start with filter on existing pages.

### Impact-ranked surfaces

| # | Surface | Value | Effort | MVP? |
|---|---|---|---|---|
| A | Alerts page — namespace facet in the rail + `?namespaces=` param | High | Medium | **YES** |
| B | Host overview tab — migrate `useNamespaceFilter` from localStorage to URL param | Medium (consistency) | Small | **YES** |
| C | Container name column on Alerts styled with muted namespace prefix | Low polish | Tiny | **YES** |
| D | K8sPvsTab / PVC view — namespace filter chip row | Medium | Small | defer |
| E | Host K8s events tab — already accepts `namespace` filter in queries; surface as chip row | Medium | Small | defer |
| F | Dedicated `/namespaces` page with aggregates | Low today | Large | defer |
| G | Namespace-scoped health rollup on Dashboard | Low for 1-cluster | Medium | defer |
| H | Webhook routing by namespace | Low | Large | defer |

### MVP (one PR)

**"Namespace filter on the Alerts page + URL-sync the existing per-host filter."**

- Alerts page:
  - `Namespace` facet group in the rail (below Monitor/hosts, above Status). `byNamespace` counts derived server-side, same shape as `byHost`.
  - `?namespaces=<comma list>` URL param.
  - Container-alert rows display the namespace prefix styled as muted (matching HostOverviewTab).
- Host overview:
  - `useNamespaceFilter` migrates from localStorage to `?ns=`.
  - One-time migration: read existing localStorage on first render, merge into URL, clear storage.
  - Keep public hook API identical so `HostOverviewTab` doesn't change.
- Tests:
  - Query test: `getAlertsExplore` with `namespaces` filter + `byNamespace` facet.
  - Round-trip test: `readFilters`/`writeFilters` for `namespaces`.
  - Helper pin test: `getContainerNamespace('kube-system/coredns-abc/coredns')` → `'kube-system'`; `getContainerNamespace('nginx')` → `null`.

## 3. Step-by-step plan (MVP)

### Backend

**`hub/src/web/queries.ts`:**
- Extend `AlertsExploreFilters` with `namespaces?: string[]` (~line 452).
- In `getAlertsExplore` (~line 499), add predicate: for each target, compare `substr(target, 1, instr(target,'/')-1)` to the filter list. Only when `instr(target,'/') > 0` — Docker targets have no slash and fall out.
- Add `byNamespace: Array<{ namespace: string; count: number }>` to the facets block, computed like `byHost`. Exclude empty namespaces.
- Update `AlertsExploreResult.counts` type.

**`hub/src/web/handlers.ts`:**
- Extend `handleAlerts` to parse `namespaces` query param (comma-split, mirrors `hosts`/`levels`).

**No schema migration. Schema stays at v36.**

### Frontend — Alerts page

`hub/src/web/frontend/src/pages/AlertsPage.tsx`:
- Extend `Filters` interface with `namespaces: string[]`.
- Extend `readFilters`/`writeFilters` to round-trip `?namespaces=a,b,c`.
- `FacetRail`: add `Namespace` FacetGroup using `counts?.byNamespace ?? []`. Hide when empty.
- `AlertsTable`: render target with muted namespace prefix when target has a `/`. Reuse `getContainerNamespace` + `getContainerDisplayName` from `@/lib/containers` (~5 lines near line 499).

`hub/src/web/frontend/src/types/api.ts`:
- Extend `AlertsExploreResponse.counts` with `byNamespace`.

### Frontend — Host overview filter URL-sync

`hub/src/web/frontend/src/hooks/useNamespaceFilter.ts`:
- Replace `useState(() => loadHidden(hostId))` with `useSearchParams()`-backed state. Param name: `ns`.
- On first mount per hostId: if URL empty and localStorage non-empty, promote localStorage → URL (`setSearchParams({ns: …}, {replace: true})`), then `localStorage.removeItem(STORAGE_PREFIX + hostId)`. One-shot migration.
- Keep public API stable — `HostOverviewTab` unchanged.

### Docker/k8s divergence

- SQL predicate `instr(target,'/') > 0` naturally excludes Docker targets.
- Host-scoped alerts (`disk_full`, `high_host_cpu`, `host_offline` etc.) have `target === host_id` with no slash — also excluded. Correct: they're not namespaced.
- Empty `byNamespace` → FacetGroup hides itself — Docker-only fleets unaffected.

### Standalone mirror

`src/db/schema.ts` + `src/web/queries.ts` — mirror the filter change (even though standalone is Docker-only, the predicate degrades gracefully).

### Tests

New:
- `tests/unit/queries-alerts-namespace-filter.test.ts` — Docker + k8s targets, filter by `['kube-system']`, assert survivors + `byNamespace`.
- `tests/unit/alerts-filters-round-trip.test.ts` — `readFilters`/`writeFilters` round-trip.
- Extension to containers-helpers test covering `getContainerNamespace` edge cases.

## 4. Explicit deferrals

- Dedicated `/namespaces/:name?` page
- Namespace facet on StoragePage K8sPvsTab/VolumesTab
- Namespace chip on HostK8sEventsTab (backend query already supports it — easy follow-up)
- Dashboard "namespace rollup" card
- Alert routing rules by namespace
- Webhook filtering by namespace
- Fleet-wide `/containers` page
- Any schema migration
- Cluster_id disambiguation of colliding namespace names across clusters

## 5. Design decisions (locked 2026-04-24)

1. **URL param name.** Alerts: `namespaces` (plural, matches `hosts`/`levels`). Host detail: `ns` (short, non-clashing). Keep them different — Alerts juggles multiple plural filters so reads cleaner plural; host detail only has this one, so short param reads fine in the URL.

2. **Hide vs. include semantics.** Keep them different. Facet rail = include (convention across hosts/levels/status on the Alerts page). Chip bar = hide (fits the visual, and include-semantics on host detail would mean empty URL → empty container list → broken first impression).

3. **`byNamespace` counts are filtered by other active filters** (host, level, status, muted, q) **but NOT by the namespace filter itself**. Standard facet-counts pattern — selecting a namespace doesn't zero out its own count. `byHost` / `byLevel` remain unfiltered as today; upgrading them is out of scope.

4. **Multi-cluster.** Not designed for now. Two `kube-system` namespaces across clusters will alias; revisit when a second cluster connects. SQL predicate stays open to later adding cluster disambiguation without migration.

5. **localStorage → URL migration is silent.** One-shot read + promote + clear on first mount. No toast.

## 6. Mixed-workload hosts (proxmox-01)

proxmox-01 runs **both Docker containers and a k3s node**. These likely register as separate host rows in the hub (different `host_id`, different `runtime_type`), so most surfaces naturally handle them independently. But: if any single host's container list mixes namespaced (k8s) and non-namespaced (Docker) containers, the filter degrades gracefully:

- `getContainerNamespace()` returns `null` for Docker targets.
- The per-host hide model filters `containers.filter(c => !hidden.includes(getNamespace(c)))` — `null` is never in the hidden list, so Docker containers always pass through.
- The Alerts page SQL predicate `instr(target,'/') > 0` excludes Docker targets from the namespace filter.
- Host-scoped alerts (disk_full, host_offline) have `target === host_id` with no slash — also excluded.

Net: on a mixed host, hiding `kube-system` hides only the k8s pods; Docker containers stay visible. No special case code needed.

## Critical files

- `/home/andreas/insightd/hub/src/web/queries.ts`
- `/home/andreas/insightd/hub/src/web/handlers.ts`
- `/home/andreas/insightd/hub/src/web/frontend/src/pages/AlertsPage.tsx`
- `/home/andreas/insightd/hub/src/web/frontend/src/hooks/useNamespaceFilter.ts`
- `/home/andreas/insightd/hub/src/web/frontend/src/lib/containers.ts`
- `/home/andreas/insightd/hub/src/web/frontend/src/types/api.ts`
