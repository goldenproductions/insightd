# Insightd

**Server awareness without the overhead.** A lightweight monitoring agent that sends you a weekly digest of how your Docker setup is doing — no dashboards, no noise, just insight.

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

That's it. Insightd will start collecting data immediately and send your first digest on schedule.

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
| `TZ` | `UTC` | Timezone for cron schedules |

## How It Works

1. **Collects** container status, resource usage, and disk metrics every 5 minutes
2. **Stores** snapshots in a local SQLite database
3. **Compares** this week's data against last week to spot trends
4. **Sends** a digest email on your configured schedule with only what matters:
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
