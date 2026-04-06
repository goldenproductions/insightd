# Insightd

Self-hosted server awareness tool for homelabbers. Monitors containers, hosts, and HTTP endpoints across multiple servers.

## Architecture

```
[Agents per host] → MQTT (Mosquitto) → [Hub] → SQLite → React UI + Email + Webhooks
```

- **Agent**: collects Docker/host/GPU/temp/disk-IO/network-IO metrics, publishes to MQTT, handles log requests + remote updates + container actions
- **Hub**: subscribes to MQTT, stores in SQLite, serves React UI on port 3000, runs insights engine v2, sends digests + alerts + webhooks
- **Standalone mode**: hub with no MQTT runs collectors locally
- **Mosquitto**: message broker, separate container (stays up during hub updates)

## Tech Stack

- Backend: Node.js 20, SQLite (better-sqlite3), dockerode, MQTT, Nodemailer, node-cron
- Frontend: React 19, TypeScript (strict), Tailwind CSS v4, Vite 6, React Router v6, TanStack Query v5
- Docker multi-arch (amd64 + arm64)
- Tests: 287 tests using `node:test` (zero external test dependencies)

## Project Structure

```
insightd/
  shared/utils/              # Logger, error handling, docker-logs parser
  shared/webhooks/           # Webhook queries + sender (Slack/Discord/Telegram/ntfy/generic)
  agent/src/                 # Collectors + MQTT publisher + updater + log handler + container actions
  agent/src/collectors/      # containers, resources, disk, host, gpu, temperature, disk-io, network-io
  hub/src/                   # DB, digest, alerts, MQTT subscriber, insights engine
  hub/src/insights/          # Baselines (time-of-day), health scores, anomaly detector, predictions, correlations
  hub/src/web/               # HTTP server, API handlers, auth (SQLite sessions + API keys), rate limiting
  hub/src/web/frontend/      # React + TypeScript SPA (Vite build → public/)
  hub/src/web/frontend/src/components/  # Shared UI components (Card, PageTitle, LoadingState, etc.)
  hub/src/web/frontend/src/hooks/       # Custom hooks (useContainerAction, useAttentionItems, useTab, etc.)
  hub/src/web/frontend/src/pages/       # Page components, decomposed into subdirectories:
    dashboard/               # DashboardPage, AttentionList, StatusRow
    containers/              # ContainerDetailPage, ContainerHistoryTab, HistorySummary, MetricGauge
    hosts/                   # HostDetailPage, HostOverviewTab, HostResourcesTab, HostAlertsTab, HostsPage
    updates/                 # UpdatesPage, HubUpdateCard, ImageUpdatesCard
  hub/src/web/public/        # Built frontend assets (served by Node HTTP server)
  hub/src/db/                # Connection, schema, settings
  src/                       # Standalone mode code (mirrors hub for single-host)
  tests/                     # Tests using node:test
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
npm test                    # Run all 287 tests
npm run build               # Build frontend (cd hub/src/web/frontend && npm run build)
docker compose build        # Build hub + agent images
docker compose up -d        # Run full stack (mosquitto + hub + agent)
```

## Docker Hub

- Images: `andreas404/insightd-hub`, `andreas404/insightd-agent`
- Current: v0.4.0
- Multi-arch: linux/amd64 + linux/arm64

## Key Environment Variables

- `INSIGHTD_ALLOW_UPDATES` — enable remote agent updates (default false)
- `INSIGHTD_ALLOW_ACTIONS` — enable container start/stop/restart (default false)
- `INSIGHTD_STATUS_PAGE` — enable public status page (default false)
- See hub/src/config.js and agent/src/config.js for full list (40+ vars)

## Database

SQLite with WAL mode. Schema v12. Key tables: container_snapshots, host_snapshots, disk_snapshots, http_endpoints, http_checks, baselines, health_scores, insights, alert_state, sessions, api_keys, webhooks, service_groups.

## UI Design Principles

- Visual hierarchy: big important things first (hero section), compact secondary info below, details on demand
- Context over raw numbers: progress bars with avg/peak markers, not just percentages
- Unified feeds: merge alerts + downtime + insights into "Needs Attention"
- Everything clickable: every status item, row, and metric should navigate somewhere
- Collapsible raw data: summaries by default, expand for details

## React Best Practices

When writing or modifying frontend code in `hub/src/web/frontend/`, follow the Vercel React best practices in `.claude/skills/react-best-practices/`. Key priorities:

1. **Eliminate waterfalls** (CRITICAL): parallel fetches with Promise.all, Suspense boundaries, defer awaits
2. **Bundle size** (CRITICAL): direct imports (no barrel files), dynamic imports for heavy components, defer third-party scripts
3. **Server-side perf** (HIGH): minimize serialized props, parallel data fetching
4. **Re-render optimization** (MEDIUM): memoize expensive components, use functional setState, derive state during render (not effects), useRef for transient values
5. **JS performance**: Set/Map for lookups, cache property access in loops, early returns, combine iterations

See `.claude/skills/react-best-practices/rules/` for detailed rule files with code examples.
