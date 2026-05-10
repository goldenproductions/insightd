# Add Agent Wizard

**Status:** Design approved (2026-05-10), pending implementation plan.

## Problem

Today's `AddAgentPage` is a flat form that only emits a `docker run` command. Insightd actually supports four deployment targets — Docker host, Kubernetes node, Proxmox VE node, and in-guest agent (Docker on a PVE VM/LXC) — and each needs a different install command. Users have to know which target they want, find the matching docs (`docs/kubernetes-setup.md`, `install.sh`, etc.), and translate field values themselves. New users with no prior knowledge of how the agent works have no on-page guidance.

After install, the user has no in-page feedback that the agent connected. They have to alt-tab to `/hosts` and refresh.

## Goals

- One page covers all four deployment targets.
- Purpose-driven flow: pick the target first, then only see fields and instructions relevant to it.
- Smart defaults so newcomers see the minimum and power users can drill into advanced tunables.
- Live verification: hub tells the user when the agent connects (and, for in-guest targets, when PVE auto-correlation completes).
- Same MQTT broker defaults already exposed via `GET /api/agent-setup` continue to drive prefill.

## Non-goals

- Custom Helm chart for the k8s target. Inlined raw manifest is sufficient — operators who want Helm can adapt it themselves.
- Windows agent target. Not supported today.
- Persistence of wizard state across page reload. Ephemeral component state is fine.
- Auto-generating a unique host_id for the user. They pick one (matches today's behavior).
- Replacing the standalone `install.sh` curl-pipe-bash script. The PVE step composes a command that calls the existing script with env vars.
- Multi-agent batch flow. One wizard run = one agent.

## Architecture

```
┌─ /add-agent ─────────────────────────────────────────────────────────┐
│  ① Target  ──▶  ② Connection  ──▶  ③ Options  ──▶  ④ Install       │
├──────────────────────────────────────────────────────────────────────┤
│  [active step body]                                                  │
├──────────────────────────────────────────────────────────────────────┤
│  [← Back]                                              [Next →]      │
└──────────────────────────────────────────────────────────────────────┘
```

**Stepper component** at top: 4 numbered pills with labels. Pills representing past steps are clickable (jump back). Future pills are disabled. Active pill highlighted.

**Body:** swaps based on `currentStep` state. Each step is its own component file.

**Footer:** Back/Next buttons; on step 4 the Next button becomes "Done" and navigates to `/hosts/<identifier>` if verification has completed (else stays put).

**State** lives in the `AddAgentPage` shell as a single `useState<WizardState>`. Children receive state + setter. No router params, no global store, no localStorage — wizard state is ephemeral.

**Validation** is per-step. The Next button calls `validate(currentStep, state)`; if it fails, the failing field highlights inline and the button stays disabled.

## State shape

```ts
type Target = 'docker' | 'k8s' | 'pve' | 'in-guest';

type WizardState = {
  target: Target | null;

  // Step 2
  identifier: string;       // host_id for docker/pve/in-guest, cluster_name for k8s
  useDefaultBroker: boolean;
  mqttUrl: string;          // ignored when useDefaultBroker
  mqttUser: string;
  mqttPass: string;

  // Step 3
  permissions: { allowUpdates: boolean; allowActions: boolean };
  advancedOpen: boolean;
  advanced: {
    collectInterval?: string;
    updateCheckCron?: string;
    tz?: string;
    diskWarnThreshold?: string;
    logLines?: string;
    logMaxLines?: string;
    image?: string;
  };
};
```

Initial state: `target=null`, `useDefaultBroker=true`, `permissions={allowUpdates: true, allowActions: true}`, `advancedOpen=false`, all advanced fields empty.

## Component design

### Step 1 — `Step1Target.tsx`

Four cards, single-select. Cards use existing `Card` component styling but render as click-to-select with selected state highlighted.

| Card | Icon | Headline | Sub-line |
|---|---|---|---|
| Docker host | 🐳 | Docker host | Linux/macOS box with Docker installed. Container metrics, updates, actions. |
| Kubernetes node | ☸ | Kubernetes | DaemonSet — one agent per node. Pod inventory, PV/PVC, events. |
| Proxmox VE | 🖥 | Proxmox VE | PVE bare-metal install. Guest inventory, ZFS, backups, quorum. |
| In-guest agent | 📦 | In-guest agent | Inside a PVE VM or LXC. Auto-correlates to its PVE host. |

Selecting a card sets `state.target`. Validation: `target !== null`.

### Step 2 — `Step2Connection.tsx`

**Identifier field.** Label and placeholder vary by target.

| Target | Label | Placeholder | Help text |
|---|---|---|---|
| docker | Host ID | `nas-01` | Unique name for this host. Used in URLs and reports. |
| in-guest | Host ID | `n8n-vm` | Unique name for this guest. The PVE side identifies it via SMBIOS UUID or hostname/MAC. |
| pve | Host ID | `proxmox-01` | Should match the PVE node hostname (output of `hostname` on the PVE shell). |
| k8s | Cluster name | `homelab` | Applied to all DaemonSet pods. Used to group nodes in the UI. |

**MQTT broker fields.** Three inputs (URL, user, password) wrapped in a `useDefaultBroker` toggle.

- Default ON: inputs grayed-out, placeholder shows the default from `GET /api/agent-setup`.
- Toggle OFF: inputs become editable.

**Identifier collision check.** On identifier blur, `useQuery` `GET /api/hosts` (already exists) and check whether the identifier matches an existing row. If yes: yellow inline note `"Host ID 'nas-01' already exists. Continuing will replace its agent."` Don't block.

**Validation:** `identifier.trim() !== '' && (useDefaultBroker || mqttUrl.trim() !== '')`.

### Step 3 — `Step3Options.tsx`

**Permissions block.** Two `Switch` components.

| Target | Switches |
|---|---|
| docker / in-guest / pve | Remote updates, Container actions |
| k8s | Container actions only (updates are GitOps in k8s) |

Each switch defaults ON; one-line description below the switch label.

**Advanced disclosure.** A `<button>` with caret + label `"Show advanced (N settings)"` where N is target-specific. Clicking sets `state.advancedOpen = true` and reveals a 2-column grid.

| Target | Advanced fields |
|---|---|
| docker / in-guest | collectInterval, updateCheckCron, tz, diskWarnThreshold, logLines, logMaxLines, image (7) |
| pve | same as docker (7) |
| k8s | collectInterval, tz, diskWarnThreshold, image (4 — no updateCheckCron, no log limits) |

Each input shows the default value as placeholder. Empty input = use default. This preserves the existing "only non-default values are included in the command" semantics.

**Validation:** none.

### Step 4 — `Step4Install.tsx`

Two stacked panels.

**Top panel — install command.** Built client-side per target by `builders/<target>.ts`. Renders via existing `<CommandBlock />` component (provides copy-to-clipboard).

| Target | Output |
|---|---|
| docker | `docker run -d ...` (current behavior, lifted into `builders/docker.ts`) |
| in-guest | `docker run -d ...` (same builder as docker) plus a one-liner note: "Auto-correlation to the PVE host completes within ~30s of first heartbeat." |
| pve | `curl -fsSL https://get.insightd.org/install \| INSIGHTD_HOST_ID=<id> INSIGHTD_MQTT_URL=<url> [...] bash` — composes env vars from state into a single call to the existing `install.sh` |
| k8s | `kubectl apply -f - <<EOF\n<DaemonSet + RBAC manifest>\nEOF` — manifest templated from `agent/k8s/` files, with `INSIGHTD_CLUSTER_NAME`, `INSIGHTD_MQTT_URL`, etc. substituted into the `env:` block |

**Bottom panel — live verification.** Polls a new endpoint with `useQuery` + `refetchInterval: 2000`.

```
GET /api/agent-setup/check?identifier=<id>&target=<target>
```

Response:

```ts
type AgentSetupCheck = {
  status: 'waiting' | 'connected';
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  proxmoxLink: { node: string; vmid: number; guestType: 'qemu' | 'lxc' } | null;
  pveCluster: string | null;
};
```

Render states:

| Condition | UI |
|---|---|
| `status === 'waiting'` | Spinner + "Waiting for agent... First heartbeat usually arrives within 30s." |
| `status === 'connected'` and target ∈ {docker, k8s, pve} | "✓ Connected. Last heartbeat: Xs ago. [→ View host page]" |
| `target === 'in-guest'` and `status === 'connected'` and `proxmoxLink === null` | "✓ Connected. Waiting for PVE auto-link..." (keep polling) |
| `target === 'in-guest'` and `proxmoxLink !== null` | "✓ Connected and auto-linked to {node} / VMID {vmid} ({guestType}). [→ View host page]" |
| `target === 'pve'` and `status === 'connected'` and `pveCluster !== null` | "✓ Connected. Cluster: {pveCluster}. [→ View host page]" |
| `target === 'pve'` and `status === 'connected'` and `pveCluster === null` | "✓ Connected (standalone PVE). [→ View host page]" |

Polling stops once the terminal-success state is reached (and stays stopped — no need for periodic re-check).

### Backend — `/api/agent-setup/check` endpoint

New route in `hub/src/web/handlers/agent-setup.ts` (existing handler file). Auth: same as other endpoints (session cookie or API key).

Implementation:

```ts
const { identifier, target } = parseQuery(req.url);

const host = db.prepare(`
  SELECT host_id, first_seen, last_seen, proxmox_node, proxmox_vmid, proxmox_guest_type, proxmox_cluster_id
    FROM hosts
   WHERE host_id = ?
`).get(identifier);

const pveCluster = target === 'pve'
  ? (db.prepare(`SELECT cluster_name FROM pve_cluster_status WHERE cluster_name = ?`)
       .get(host?.proxmox_cluster_id ?? '')?.cluster_name ?? null)
  : null;

return {
  status: host ? 'connected' : 'waiting',
  firstSeenAt: host?.first_seen ?? null,
  lastSeenAt: host?.last_seen ?? null,
  proxmoxLink: host?.proxmox_vmid != null
    ? { node: host.proxmox_node, vmid: host.proxmox_vmid, guestType: host.proxmox_guest_type }
    : null,
  pveCluster,
};
```

For `target === 'k8s'`, the identifier is the cluster_id (== `INSIGHTD_HOST_GROUP` env var on each k8s agent, per the warning in `agent/src/config.ts:157`). Each DaemonSet pod publishes its own per-node `collection` topic with `runtime_type='kubernetes'` and `host_group = <cluster_id>`. Detection: `SELECT 1 FROM hosts WHERE host_group = ? AND runtime_type = 'kubernetes' LIMIT 1`. First node to report flips status to connected.

No new DB schema. Read-only against existing tables.

## Edge cases

| Case | Behavior |
|---|---|
| User picks identifier that already exists | Yellow inline note on step 2; not blocked. If they install, the new agent's heartbeat replaces the old row. Same as today. |
| User abandons wizard mid-flow (navigates away) | State lost; on return, fresh wizard. Acceptable for v1. |
| `GET /api/agent-setup` (broker defaults) fails | Step 2 falls back to empty placeholders; toggle "use defaults" cannot stay ON. Show inline error: "Could not load broker defaults. Enter manually." |
| Hub has no broker creds configured at all | Same fallback as above. User enters everything manually. |
| Verification endpoint times out | `useQuery` retry semantics handle it. UI stays in waiting state. |
| User installs agent then immediately stops it | First heartbeat arrives → status flips to connected → no further heartbeats. UI stays "Connected. Last heartbeat: Xs ago" because the host row exists. Acceptable — the wizard's job ends at "first sign of life." |
| In-guest agent on bare-metal box (false target choice) | Identity-hint matcher returns null → `proxmoxLink` stays null → UI sits at "Waiting for PVE auto-link...". After 60s of waiting in this state, render a "Skip auto-link check" link that flips the wizard to the generic connected state and stops polling. |
| k8s DaemonSet rolling out across N nodes | First node's heartbeat flips status to connected. The `cluster_id` is shared, so the wizard's check resolves on first one. Acceptable — operator can verify all nodes joined via the Hosts page. |
| PVE target on a standalone (non-cluster) PVE | `pveCluster` is null. "Connected (standalone PVE)" copy handles it explicitly. |

## Testing

| File | Coverage |
|---|---|
| `tests/unit/builder-docker.test.ts` | Default state → expected `docker run`; allow_updates=false → `:ro` on socket mount; advanced field set → env var emitted; advanced field at default → env var omitted; identifier with shell metacharacters is quoted properly |
| `tests/unit/builder-k8s.test.ts` | Output is yaml-parseable; contains DaemonSet + ServiceAccount + ClusterRole + ClusterRoleBinding; `INSIGHTD_CLUSTER_NAME` / `INSIGHTD_MQTT_URL` env entries appear; image swap propagates to container spec |
| `tests/unit/builder-pve.test.ts` | curl-bash form; env vars correctly composed and quoted; defaults omitted same as docker builder |
| `tests/unit/handler-agent-setup-check.test.ts` | (a) `waiting` when no host row; (b) `connected` when host row exists; (c) `proxmoxLink` populated when host row has proxmox_* set; (d) `pveCluster` populated for target=pve when proxmox_cluster_id matches a `pve_cluster_status` row; (e) k8s target with cluster_id matches at least one `k8s/<cluster>/<node>` host_id |

Frontend: skip component-level tests (existing pattern in `tests/unit/` is backend-heavy). Manual UX test on vdev covers the integration.

**Manual UX test on vdev (post-deploy):**

1. Wizard with target=Docker, identifier=`vdev-test-$(date +%s)`, defaults — copy command, run on vdev itself, confirm verification flips green within 30s.
2. Wizard with target=k8s, identifier=`insightd-test`, defaults — copy `kubectl apply` command, run against the existing k3d test cluster (memory: `reference_k3d_test_env`), confirm verification flips green.
3. Wizard with target=pve, identifier=`proxmox-01`, defaults — confirm the wizard recognizes the existing PVE agent immediately (collision warning expected) and verification shows the cluster name.
4. Wizard with target=in-guest, identifier=`n8n-vm-test`, defaults — copy command, run on the n8n VM (10.0.0.125), wait ~30s, confirm verification confirms PVE auto-link (proxmox-01 / VMID).

## Migration & rollout

- Old `pages/AddAgentPage.tsx` deleted; route in `App.tsx` updated to point at the new path.
- No DB schema change.
- New backend endpoint is additive; old endpoints unchanged.
- Existing `GET /api/agent-setup` payload is unchanged (the wizard reuses it for broker defaults).
- No telemetry, no feature flag — ship to all users.

## Surface summary

- 1 new page (under `pages/add-agent/`): shell + 4 step components + 3 builders + types
- 1 deleted page (`pages/AddAgentPage.tsx`)
- 1 new backend endpoint (`/api/agent-setup/check`) inside an existing handler file
- 4 new unit test files
- 0 schema migrations
- 0 new dependencies
