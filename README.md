# Insightd

**Server awareness without the overhead.** A self-hosted monitoring tool for self-hosters that watches your containers, hosts, and HTTP endpoints across Docker, Kubernetes, and Proxmox VE — and tells you *why* something broke, not just *what*.

Most self-hosted monitors cover one runtime. Insightd treats Docker containers, Kubernetes pods (with full namespace topology and workload health), and Proxmox LXC/QEMU guests (with ZFS, backups, and quorum) as first-class citizens in the same UI. When a container goes unhealthy, it correlates metrics, restart history, host state, and log patterns into a ranked explanation — so you spend less time digging. Calm alerts by default (capacity thresholds, not 1.4% baseline noise), modern web dashboard, email + webhook delivery. Privacy-first, SQLite-backed, one-command Docker install.

Demo video and screenshots are being prepared. For now, the install steps below show the core workflows you can run locally — install takes under 5 minutes on a single host. Example weekly digest email (real format, fictional numbers):

```
Insightd — Week 14

Uptime:       99.8%  (Vaultwarden down 2h Tuesday)
Updates:      3 containers have new versions available
Resources:    Postgres using 20% more RAM than last week
Restarts:     2  (Nginx, Redis)
Health Score: 92/100

No critical issues. Good week.
```

## Try it

- [Quick Start guide](https://docs.insightd.org/guides/quick-start/) — Docker Compose walkthrough
- Or jump straight to [single-server install](#single-server-standalone-mode) below

> **First-time user?** I'm actively collecting early-user feedback. If you try insightd, I'm especially looking for feedback on whether **install worked on the first try**, **what environment you used**, and **what was confusing**. → [Join the discussion](https://github.com/goldenproductions/insightd/discussions/286)

## Who is this for?

Insightd is for self-hosters and homelabbers running Docker, Kubernetes/k3s, Proxmox VE, or a mix of them — especially if you want useful server awareness without building and maintaining a full Prometheus/Grafana stack.

It is a good fit if you want to know:

- which hosts, containers, pods, or endpoints need attention
- why something likely broke
- whether alerts are actionable instead of noisy
- what changed across your small fleet over time

## What v0.1 does today

In v0.1, insightd can:

- install a hub and local agent with Docker
- monitor Docker containers, Kubernetes/k3s nodes/pods, Proxmox VE guests, and HTTP endpoints
- show host, container, endpoint, metrics, logs, and status in a web UI
- surface insights and ranked diagnosis when something looks unhealthy
- send email digests and alerts
- deliver webhook alerts to Slack, Discord, Telegram, ntfy, or generic endpoints
- run self-hosted with SQLite and no external database

## Non-goals / not yet

Insightd v0.1 is intentionally not:

- a hosted SaaS
- an enterprise Prometheus/Grafana replacement
- long-term high-cardinality metrics storage
- a public MQTT service — keep MQTT private to your network/VPN
- a guarantee that every runtime, OS, or edge case is supported yet

## Features

- **Multi-host, multi-runtime monitoring** — deploy agents on each server reporting to a central hub via MQTT. Docker, Kubernetes/k3s (DaemonSet mode), and Proxmox VE (LXC + QEMU guests, ZFS pools, storage saturation, backup overdue, cluster quorum) are all first-class.
- **Research-grounded diagnosis engine** — when a container is unhealthy, seven signal detectors fuse metrics, robust baselines, restart history, host state, and Drain-mined log patterns into a ranked explanation with correlated upstream services via Personalized PageRank. Based on Drain (ICWS 2017), MicroRCA (NOMS 2020), and Adtributor (NSDI 2014).
- **Smart alerts with calibrated confidence** — 10 alert types with cooldowns, exponential reminder backoff, per-alert silencing, and webhook delivery (Slack, Discord, Telegram, ntfy, generic). Thumbs-up/down feedback on diagnosis cards recalibrates future confidence via a Beta posterior.
- **Insights & anomaly detection** — time-of-day baselines, predictive alerts, trend detection, and Seasonal-Hybrid ESD on hourly rollups. A dedicated `/insights` page surfaces analytical signals separate from operational "Needs Attention" alerts.
- **Modern web dashboard** — React UI with health score, uptime timelines, per-container charts, host grouping, stacks (auto-detected from Docker Compose), public status page, keyboard shortcuts, and a setup wizard that means no `.env` file is required.

## Quick Start

### Single Server (Standalone Mode)

The fastest way to get started. One container, no MQTT needed.

```bash
docker run -d \
  --name insightd \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:ro \
  -v insightd-data:/data \
  -p 3000:3000 \
  andreas404/insightd-hub:latest
```

Open **http://your-server:3000** and follow the **Setup Wizard** — it walks you through setting a password, configuring email, and adding agents.

### Multi-Server (One Command)

For monitoring multiple servers, insightd uses MQTT to connect lightweight agents to a central hub. One command brings up Mosquitto, the hub, and a local agent — MQTT credentials are auto-generated and surfaced in the UI's **Add Agent** page for remote enrollment.

```bash
curl -sSL https://insightd.org/install.sh | bash
```

The script is ~40 lines of bash and [public on GitHub](https://github.com/goldenproductions/insightd.org/blob/main/public/install.sh) — audit before running if you prefer. See the [Quick Start guide](https://docs.insightd.org/guides/quick-start/) for the manual Docker Compose walkthrough.

#### Manual Docker Compose

If you'd rather clone the repo and run `docker compose` yourself, generate an MQTT password into `.env` **before** the first `compose up` — the bootstrap container refuses to create an empty-password broker user and will fail fast otherwise:

```bash
git clone https://github.com/goldenproductions/insightd.git
cd insightd
printf 'INSIGHTD_MQTT_USER=insightd\nINSIGHTD_MQTT_PASS=%s\n' \
  "$(openssl rand -hex 24)" > .env
docker compose -f docker-compose.hub.yml up -d
```

`.env` is the source of truth for your MQTT credentials — back it up. Re-running `compose up` is idempotent and won't rotate the password.

### Kubernetes / k3s

Run the agent as a DaemonSet — one pod per node, each reports its node as a host. See the [Kubernetes guide](https://docs.insightd.org/guides/kubernetes/) for the full setup.

## Web UI

The hub serves a dashboard at `http://localhost:3000`. See [insightd.org](https://insightd.org) for screenshots of the dashboard, container detail, host detail, and insights pages.

## Architecture

![Insightd architecture](docs/diagrams/insightd-architecture-diagram.png)

- **Agent** — collects Docker and host metrics, publishes to MQTT, handles log requests, container actions, and remote updates
- **Hub** — subscribes to MQTT, stores in SQLite, serves the React UI, runs the insights engine, sends alerts and digests
- **Standalone mode** — hub without MQTT runs collectors locally (single-host)
- **Mosquitto** — MQTT broker in a separate container (stays up during hub/agent updates)

## Configuration

All configuration can be done via the **Setup Wizard** and **Settings page** in the web UI after the hub is deployed — no `.env` file required. Most settings are hot-reloadable and take effect without a restart. Environment variables are also supported; see the [full configuration reference](https://docs.insightd.org/reference/config/) for every variable.

### Key variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_MQTT_URL` | — | MQTT broker URL (enables hub mode) |
| `INSIGHTD_HOST_ID` | `local` | Identifies this host in multi-host setups |
| `INSIGHTD_HOST_GROUP` | — | Optional logical group label for the Hosts page |
| `INSIGHTD_RUNTIME` | `auto` | Container runtime: `auto`, `docker`, or `kubernetes` |
| `INSIGHTD_ADMIN_PASSWORD` | — | Admin password for the web UI |
| `INSIGHTD_ALLOW_ACTIONS` | `false` | Enable container start/stop/restart from UI (Docker only) |
| `INSIGHTD_ALLOW_UPDATES` | `false` | Enable remote agent updates from hub (Docker only) |
| `INSIGHTD_STATUS_PAGE` | `false` | Enable public status page at `/status` |
| `GEMINI_API_KEY` | — | Enables the "Diagnose with AI" button on container detail |
| `TZ` | `UTC` | Timezone for cron schedules |

Everything else — SMTP, alert thresholds, retention, webhooks, AI diagnosis model, digest schedule — can be tweaked from the Settings page inside the hub after it's deployed.

## Docker Images

Available on Docker Hub as multi-arch images (amd64 + arm64):

- [`andreas404/insightd-hub`](https://hub.docker.com/r/andreas404/insightd-hub)
- [`andreas404/insightd-agent`](https://hub.docker.com/r/andreas404/insightd-agent)

## Resource Usage

Insightd is designed to be lightweight. Typical footprint on a homelab with ~10 hosts:

- **Hub**: ~180 MB RAM
- **Agent**: ~40 MB RAM per host
- **Mosquitto**: ~10 MB RAM
- **SQLite** for storage — no external database needed
- Raw snapshots auto-pruned after 30 days (configurable), with hourly rollups kept for 365 days for long-term trends

MIT
