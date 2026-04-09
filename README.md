# Insightd

**Server awareness without the overhead.** A self-hosted monitoring tool for homelabbers that watches your Docker containers, hosts, and HTTP endpoints across multiple servers — with a modern web dashboard, smart alerts, and weekly digests.

```
Insightd — Week 14

Uptime:       99.8%  (Vaultwarden down 2h Tuesday)
Updates:      3 containers have new versions available
Resources:    Postgres using 20% more RAM than last week
Restarts:     2  (Nginx, Redis)
Health Score: 92/100

No critical issues. Good week.
```

## Features

- **Multi-host monitoring** — deploy agents on each server, all reporting to a central hub via MQTT
- **Multi-runtime support** — Docker (default) and Kubernetes/k3s (DaemonSet mode), one agent per node
- **Container monitoring** — status, CPU, RAM, restarts, network/block I/O, health checks
- **Host system metrics** — CPU, memory, load, uptime, GPU, temperature, disk I/O, network I/O
- **Disk monitoring** — usage warnings with "X days until full" forecasts
- **HTTP endpoint monitoring** — uptime, response time, configurable intervals
- **Smart insights engine** — capacity-based health scoring (only flags actual saturation, not baseline deviation), time-of-day baselines, predictive alerts, correlation detection
- **Insights page** — dedicated `/insights` view with expandable cards, thumbs up/down feedback, and per-session dismiss
- **Real-time alerts** — 10 alert types with cooldowns, auto-resolution, and webhook delivery
- **Webhook notifications** — Slack, Discord, Telegram, ntfy, or any generic webhook
- **Weekly digest emails** — HTML + plaintext summary of the week
- **Container actions** — start/stop/restart/remove containers from the UI (opt-in, Docker mode only)
- **Remove containers** — delete exited containers + clean all insightd data (alerts, history, baselines)
- **Remote agent updates** — update agents from the hub UI via MQTT (opt-in, Docker mode only)
- **Image update detection** — compares local images against Docker Hub
- **Explainable alerts** — every alert stores why it fired (value, threshold, message) so you can understand what happened
- **Metric personalities** — baseline-aware human-friendly moods on every metric (e.g. "😌 Normal", "🔥 Way above normal")
- **Health score breakdown** — click the system health score to see per-host factor analysis
- **Service groups** — organize containers by purpose, auto-detect from Docker Compose/labels
- **Public status page** — shareable uptime page, no auth required (opt-in)
- **API keys** — programmatic access with hashed key storage
- **Full UI onboarding** — setup wizard configures everything including SMTP, no .env file required

## Quick Start

### Standalone (single host)

If you only have one server, run the hub directly — no MQTT needed:

```bash
docker run -d \
  --name insightd \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:ro \
  -v insightd-data:/data \
  -e TZ=UTC \
  andreas404/insightd-hub:latest
```

Open `http://localhost:3000` and follow the setup wizard.

### Multi-host (hub + agents)

For monitoring multiple servers, you need an MQTT broker, the hub, and an agent on each host.

**1. On your main server** — start the hub stack:

```bash
git clone https://github.com/goldenproductions/insightd.git
cd insightd
cp .env.example .env   # edit with your settings
docker compose -f docker-compose.hub.yml up -d
```

This starts Mosquitto (MQTT broker), the hub, and a local agent.

**2. On each remote server** — run an agent:

```bash
docker run -d \
  --name insightd-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /:/host:ro \
  -e INSIGHTD_HOST_ID=my-server \
  -e INSIGHTD_MQTT_URL=mqtt://hub-ip:1883 \
  -e INSIGHTD_MQTT_USER=insightd \
  -e INSIGHTD_MQTT_PASS=your-mqtt-password \
  andreas404/insightd-agent:latest
```

Or use the setup command shown in the hub's **Add Agent** page.

### Kubernetes / k3s

Run the agent as a DaemonSet — one pod per node, each reports its node as a host. See [`docs/kubernetes-setup.md`](docs/kubernetes-setup.md) for the full guide.

```bash
kubectl apply -f agent/k8s/rbac.yaml
kubectl apply -f agent/k8s/daemonset.yaml
```

Edit `agent/k8s/daemonset.yaml` first to set your `INSIGHTD_MQTT_URL`. Each pod's containers appear in insightd as `{namespace}/{pod-name}/{container-name}`. K8s mode is read-only — actions and image update checks aren't supported (those are managed by the cluster).

## Web UI

The hub serves a dashboard at `http://localhost:3000`:

- **Dashboard** — health score with clickable breakdown, availability, compact status bar, unified "Needs Attention" feed, metric personalities
- **Hosts** — grid of all connected agents with status and metrics
- **Host detail** — tabbed view: overview, resources, alerts
- **Container detail** — CPU/memory gauges, logs, status history
- **Endpoints** — HTTP endpoint monitoring with uptime timelines
- **Services** — container groups with aggregate status
- **Alerts** — full alert history with reason, trigger value, and threshold
- **Insights** — analytical signals (predictions, trends, performance) with thumbs up/down feedback
- **Updates** — available image updates, remote agent updates
- **Status page** — public uptime view (enable with `INSIGHTD_STATUS_PAGE=true`)
- **Settings** — email, alerts, thresholds, API keys

## Architecture

```
[Agents per host] --> MQTT (Mosquitto) --> [Hub] --> SQLite --> React UI
                                                          +--> Email digests
                                                          +--> Webhooks
                                                          +--> Alerts
```

- **Agent** — collects Docker and host metrics, publishes to MQTT, handles log requests, container actions, and remote updates
- **Hub** — subscribes to MQTT, stores in SQLite, serves the React UI, runs the insights engine, sends alerts and digests
- **Standalone mode** — hub without MQTT runs collectors locally (single-host)
- **Mosquitto** — MQTT broker in a separate container (stays up during hub/agent updates)

## Configuration

All configuration can be done via the **Setup Wizard** and **Settings page** in the UI — no `.env` file required. Environment variables are also supported and documented in [`.env.example`](.env.example).

### Key variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_MQTT_URL` | — | MQTT broker URL (enables hub mode) |
| `INSIGHTD_HOST_ID` | `local` | Identifies this host in multi-host setups |
| `INSIGHTD_RUNTIME` | `auto` | Container runtime: `auto`, `docker`, or `kubernetes` |
| `INSIGHTD_ADMIN_PASSWORD` | — | Admin password for the web UI |
| `INSIGHTD_ALLOW_ACTIONS` | `false` | Enable container start/stop/restart from UI |
| `INSIGHTD_ALLOW_UPDATES` | `false` | Enable remote agent updates from hub |
| `INSIGHTD_STATUS_PAGE` | `false` | Enable public status page at `/status` |
| `INSIGHTD_ALERTS_ENABLED` | `false` | Enable real-time alerts |
| `INSIGHTD_SMTP_HOST` | — | SMTP server for email digest/alerts |
| `INSIGHTD_DIGEST_CRON` | `0 8 * * 1` | Digest schedule (default: Monday 08:00) |
| `INSIGHTD_COLLECT_INTERVAL` | `5` | Collection interval in minutes |
| `INSIGHTD_DISK_WARN_THRESHOLD` | `85` | Disk usage warning threshold (%) |
| `TZ` | `UTC` | Timezone for cron schedules |

## Docker Images

Available on Docker Hub as multi-arch images (amd64 + arm64):

- [`andreas404/insightd-hub`](https://hub.docker.com/r/andreas404/insightd-hub)
- [`andreas404/insightd-agent`](https://hub.docker.com/r/andreas404/insightd-agent)

## Resource Usage

Insightd is designed to be lightweight:

- **~28MB RAM** in typical use
- **SQLite** for storage — no external database needed
- Data older than 30 days is automatically pruned

## Development

```bash
git clone https://github.com/goldenproductions/insightd.git
cd insightd
npm install
npm test                    # Run tests
npm run build               # Build frontend
docker compose build        # Build Docker images
```

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT
