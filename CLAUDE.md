# Insightd

Self-hosted server awareness tool for homelabbers. Monitors containers, hosts, and HTTP endpoints across multiple servers and container runtimes.

## Architecture

```
[Agents per host/node] → MQTT (Mosquitto) → [Hub] → SQLite → React UI + Email + Webhooks
```

- **Agent**: collects container/host metrics, publishes to MQTT, handles log requests + actions
  - Supports multiple container runtimes via `agent/src/runtime/` abstraction (Docker; Kubernetes via DaemonSet)
  - Auto-detects runtime by socket probing, or set `INSIGHTD_RUNTIME=docker|kubernetes`
  - In k8s mode, host CPU/memory/uptime come from kubelet (`/stats/summary` + Node API capacity), not `/proc`. Load average, CPU temperature, gpu, disk-io, and network-io are explicitly NULL because `/proc` and `/sys` inside a containerized agent reflect the underlying machine, not the node.
- **Hub**: subscribes to MQTT, stores in SQLite, serves React UI on port 3000, runs insights engine, sends digests + alerts + webhooks
- **Standalone mode**: hub with no MQTT runs collectors locally (Docker only)
- **Mosquitto**: message broker, separate container (stays up during hub updates)

## Tech Stack

- Backend: Node.js 20, TypeScript (strict), SQLite (better-sqlite3), dockerode, @kubernetes/client-node, MQTT, Nodemailer, node-cron, tsx
- Frontend: React 19, TypeScript (strict), Tailwind CSS v4, Vite 6, React Router v6, TanStack Query v5
- Docker multi-arch (amd64 + arm64)
- Tests: ~480 tests using `node:test` + tsx (zero external test dependencies)

## Project Structure

```
insightd/
  shared/utils/              # Logger, error handling, docker-logs parser
  shared/webhooks/           # Webhook queries + sender (Slack/Discord/Telegram/ntfy/generic)
  agent/src/                 # MQTT publisher + scheduler + updater
  agent/src/runtime/         # Container runtime abstraction (Docker, Kubernetes)
    types.ts                 #   ContainerRuntime interface and shared types
    docker.ts                #   DockerRuntime — listContainers, collectResources, fetchLogs, performAction, checkImageUpdates
    kubernetes.ts            #   KubernetesRuntime — pod listing, kubelet cAdvisor + /stats/summary metrics, K8s API logs, getHostMetrics override (read-only)
    detect.ts                #   Socket-based runtime auto-detection
    index.ts                 #   getRuntime() factory
  agent/src/collectors/      # Host-level collectors (disk, host, gpu, temperature, disk-io, network-io)
  agent/k8s/                 # Kubernetes manifests (DaemonSet, RBAC) for k8s/k3s deployment
  hub/src/                   # DB, digest, alerts, MQTT subscriber, insights engine
  hub/src/insights/          # Baselines (time-of-day), health scores, capacity-based detector, predictions, correlations
  hub/src/web/               # HTTP server, API handlers, auth (SQLite sessions + API keys), rate limiting
  hub/src/web/frontend/      # React + TypeScript SPA (Vite build → public/)
  hub/src/web/frontend/src/components/  # Shared UI components (Card, Button, Skeleton, InsightsFeed, etc.)
  hub/src/web/frontend/src/hooks/       # Custom hooks (useContainerAction, useAttentionItems, useFormMessage)
  hub/src/web/frontend/src/lib/         # queryKeys factory, analogies, ratings, formatters, api client
  hub/src/web/frontend/src/pages/       # Page components, decomposed into subdirectories:
    dashboard/               # DashboardPage, AttentionList, StatusRow
    containers/              # ContainerDetailPage, ContainerHistoryTab, HistorySummary, MetricGauge
    hosts/                   # HostDetailPage (with HostGroupEditor), HostOverviewTab, HostResourcesTab, HostAlertsTab, HostsPage (collapsible group sections)
    updates/                 # UpdatesPage, HubUpdateCard, AgentUpdatesCard, ImageUpdatesCard
    StacksPage.tsx, StackDetailPage.tsx, StackFormPage.tsx  # Container groups (renamed from "Services" in #72)
    InsightsPage.tsx         # Dedicated insights page with feedback (thumbs up/down)
  hub/src/web/public/        # Built frontend assets (served by Node HTTP server)
  hub/src/db/                # Connection, schema (currently v17), settings
  src/                       # Standalone mode code (Docker only, mirrors hub for single-host)
  tests/                     # Tests using node:test
  docs/                      # Setup guides (kubernetes-setup.md)
  .github/workflows/         # CI + Docker Hub publish (tags only)
```

## Development Workflow

- Plan before implementing non-trivial features
- Feature branches + PRs for substantial changes; direct-to-main for small fixes
- Always run `npm test` before merging — CI must pass
- Tag releases with semver: `hub-v*` and `agent-v*` tags trigger independent Docker Hub publishes
- Test on live VM after deploying (3 hosts: proxmox-01, Birthday-invitation-server, n8n)

## Commands

```bash
npm test                    # Run all tests via tsx
npm run typecheck           # Type-check without emitting (tsc --noEmit)
npm run build               # Build frontend (cd hub/src/web/frontend && npm run build)
docker compose build        # Build hub + agent images
docker compose up -d        # Run full stack (mosquitto + hub + agent)
```

## Docker Hub

- Images: `andreas404/insightd-hub`, `andreas404/insightd-agent`
- Multi-arch: linux/amd64 + linux/arm64
- Tags: `hub-v*` and `agent-v*` trigger independent CI publishes
- Latest tagged release isn't tracked here — check `git tag --list 'hub-v*'` or Docker Hub for the current version

## Key Environment Variables

- `INSIGHTD_RUNTIME` — container runtime: `auto` (default), `docker`, or `kubernetes`
- `INSIGHTD_HOST_GROUP` — optional logical group label (e.g. "production-cluster", "basement"). Surfaces as collapsible sections on the Hosts page. Manual UI override via PUT `/api/hosts/:id/group` always wins over the env var.
- `INSIGHTD_ALLOW_UPDATES` — enable remote agent updates (default false, Docker only)
- `INSIGHTD_ALLOW_ACTIONS` — enable container start/stop/restart (default false, Docker only)
- `INSIGHTD_STATUS_PAGE` — enable public status page (default false)
- `NODE_NAME` / `NODE_IP` — required in Kubernetes DaemonSet mode (set via downward API)
- See hub/src/config.ts and agent/src/config.ts for full list (40+ vars)

## Database

SQLite with WAL mode. **Schema v17.** Key tables: container_snapshots, host_snapshots, disk_snapshots, http_endpoints, http_checks, baselines, health_scores, insights, insight_feedback, alert_state, sessions, api_keys, webhooks, service_groups (still named in DB; surfaces as "Stacks" in the UI), hosts (with `runtime_type`, `host_group`, and `host_group_override` columns — the UI override beats the agent-reported value via COALESCE in queries).

Both schema files (`hub/src/db/schema.ts` and `src/db/schema.ts`) create `sessions`, `api_keys`, and `insight_feedback` in the bootstrap CREATE TABLE batch — fresh installs need them on first boot, not just via the v12/v14 migration paths (fixed in #74).

## UI Design Principles

See `.impeccable.md` for the full design context. Key principles:

- Visual hierarchy: big important things first (hero section), compact secondary info below, details on demand
- Context over raw numbers: progress bars with avg/peak markers, not just percentages
- Separate operational vs analytical: "Needs Attention" (alerts/downtime) and "Insights" (predictions/trends) are distinct sections on the dashboard
- Everything clickable: every status item, row, and metric should navigate somewhere
- Collapsible raw data: summaries by default, expand for details
- Consistent visual language: cards use colored left borders, category icons, and full-text messages (no truncation)

## Insights Philosophy

**Usage is healthy, saturation is the problem.** Health scores and detector insights use capacity-based thresholds, not baseline deviation:

- Host CPU: only flagged when >70% (normal/elevated/high/critical thresholds)
- Host memory: only flagged when >80% of total capacity
- Host load: only flagged when >4
- Container CPU: <50% always rated normal, regardless of percentile position
- Trends: only flag if current value is already concerning (e.g. CPU >40% AND doubled)
- Predictions: validate against latest snapshot, require live value above P75

This prevents false positives like "memory critical at 1.4% usage" from low-baseline noise.

## React Best Practices

When writing or modifying frontend code in `hub/src/web/frontend/`, follow the Vercel React best practices in `.claude/skills/react-best-practices/`. Key priorities:

1. **Eliminate waterfalls** (CRITICAL): parallel fetches with Promise.all, Suspense boundaries, defer awaits
2. **Bundle size** (CRITICAL): direct imports (no barrel files), dynamic imports for heavy components, defer third-party scripts
3. **Server-side perf** (HIGH): minimize serialized props, parallel data fetching
4. **Re-render optimization** (MEDIUM): memoize expensive components, use functional setState, derive state during render (not effects), useRef for transient values
5. **JS performance**: Set/Map for lookups, cache property access in loops, early returns, combine iterations

See `.claude/skills/react-best-practices/rules/` for detailed rule files with code examples.
