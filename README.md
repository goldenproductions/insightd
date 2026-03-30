# Insightd

**Server awareness without the overhead.** A lightweight monitoring tool that gives you a web dashboard and weekly digest of how your Docker setup is doing — real-time visibility plus proactive summaries, without the noise.

```
🟢 Insightd — Week 14

Uptime:       99.8%  (Vaultwarden down 2h Tuesday)
Updates:      3 containers have new versions available
Resources:    Postgres using 20% more RAM than last week
Restarts:     2  (Nginx, Redis)

No critical issues. Good week.
```

## Quick Start

**1. Clone and configure**

```bash
git clone https://github.com/goldenproductions/insightd.git
cd insightd
cp .env.example .env
```

Edit `.env` with your SMTP credentials and preferences.

**2. Run with Docker Compose**

```bash
docker compose up -d
```

**Or with `docker run`:**

```bash
docker build -t insightd .
docker run -d \
  --name insightd \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:ro \
  -v insightd-data:/data \
  --env-file .env \
  insightd
```

That's it. Insightd will start collecting data immediately, serve the web UI at `http://localhost:3000`, and send your first digest on schedule.

## What It Monitors

| Metric | How |
|--------|-----|
| **Container status** | Running, stopped, restarting — via Docker socket |
| **CPU & RAM per container** | Collected every 5 minutes, compared week-over-week |
| **Host disk usage** | Alerts when usage exceeds threshold (default: 85%) |
| **Available updates** | Compares local image digests with Docker Hub daily |

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_SMTP_HOST` | — | SMTP server hostname |
| `INSIGHTD_SMTP_PORT` | `587` | SMTP port |
| `INSIGHTD_SMTP_USER` | — | SMTP username |
| `INSIGHTD_SMTP_PASS` | — | SMTP password or app password |
| `INSIGHTD_SMTP_FROM` | `SMTP_USER` | Sender email address |
| `INSIGHTD_DIGEST_TO` | — | Recipient email address |
| `INSIGHTD_DIGEST_CRON` | `0 8 * * 1` | Digest schedule (default: Monday 08:00) |
| `INSIGHTD_DISK_WARN_THRESHOLD` | `85` | Disk usage warning threshold (%) |
| `INSIGHTD_COLLECT_INTERVAL` | `5` | Collection interval in minutes |
| `INSIGHTD_WEB_ENABLED` | `true` | Set to `false` to disable the web UI |
| `INSIGHTD_WEB_PORT` | `3000` | Web UI HTTP port |
| `INSIGHTD_WEB_HOST` | `0.0.0.0` | Web UI bind address |
| `TZ` | `UTC` | Timezone for cron schedules |

## Web UI

The hub serves a built-in web dashboard at `http://localhost:3000` (enabled by default). No extra setup needed.

- **Dashboard** — aggregate health: hosts online, containers running, active alerts, disk warnings
- **Hosts** — grid view of all connected agents with status and container counts
- **Host detail** — per-container CPU/RAM/restarts, disk usage, active alerts, available updates
- **Alerts** — full alert history with trigger/resolution times

### REST API

The web UI is backed by a REST API you can also use directly:

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Hub health check |
| `GET /api/dashboard` | Aggregate summary across all hosts |
| `GET /api/hosts` | List all hosts with online/offline status |
| `GET /api/hosts/:id` | Host detail with containers, disk, alerts, updates |
| `GET /api/hosts/:id/containers` | Latest container snapshots |
| `GET /api/hosts/:id/disk` | Latest disk snapshots |
| `GET /api/alerts` | Alert list (default: active only, `?active=false` for all) |

## How It Works

1. **Collects** container status, resource usage, and disk metrics every 5 minutes
2. **Stores** snapshots in a local SQLite database
3. **Serves** a real-time web dashboard for immediate visibility
4. **Compares** this week's data against last week to spot trends
5. **Sends** a digest email on your configured schedule with only what matters:
   - Uptime percentages per container
   - Restart counts
   - Resource trend changes (>10% flagged)
   - Disk space warnings
   - Available image updates

## Resource Usage

Insightd is designed to be lightweight:

- **~28MB RAM** in typical use
- **No inbound ports** required
- **SQLite** for storage — no external database needed
- Data older than 30 days is automatically pruned

## Requirements

- Docker
- SMTP credentials for email delivery (Gmail with App Password works great)

## License

MIT
