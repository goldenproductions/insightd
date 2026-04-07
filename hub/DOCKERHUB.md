# Insightd Hub

**Server awareness without the overhead.** Central hub for [insightd](https://github.com/goldenproductions/insightd) — a self-hosted monitoring tool for homelabbers.

Monitors Docker containers, hosts, and HTTP endpoints across multiple servers. Includes a modern React dashboard, smart alerts, weekly digest emails, and webhook notifications.

## Quick Start

### Standalone (single host, no MQTT needed)

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

### Multi-host (with MQTT + agents)

```yaml
# docker-compose.yml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    ports:
      - "1883:1883"

  hub:
    image: andreas404/insightd-hub:latest
    restart: unless-stopped
    depends_on:
      - mosquitto
    ports:
      - "3000:3000"
    volumes:
      - hub-data:/data
    environment:
      INSIGHTD_MQTT_URL: mqtt://mosquitto:1883
      INSIGHTD_ADMIN_PASSWORD: changeme
      TZ: UTC

volumes:
  hub-data:
```

Then deploy [`andreas404/insightd-agent`](https://hub.docker.com/r/andreas404/insightd-agent) on each remote host.

## Features

- **Dashboard** — health scores, availability, unified "Needs Attention" feed
- **Container monitoring** — status, CPU, RAM, restarts, network/block I/O, health checks
- **Host metrics** — CPU, memory, load, disk, GPU, temperature
- **HTTP endpoint monitoring** — uptime tracking, response times
- **Insights engine** — time-of-day baselines, anomaly detection, predictive alerts, correlations
- **Real-time alerts** — 10 alert types with cooldowns and auto-resolution
- **Webhooks** — Slack, Discord, Telegram, ntfy, or generic
- **Weekly digest emails** — HTML + plaintext summaries
- **Container actions** — start/stop/restart from the UI (opt-in)
- **Service groups** — organize containers across hosts
- **Public status page** — shareable uptime page at `/status` (opt-in)
- **API keys** — programmatic access with hashed storage

## Configuration

All via environment variables. Key ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_MQTT_URL` | — | MQTT broker (enables hub mode) |
| `INSIGHTD_ADMIN_PASSWORD` | — | Admin password for web UI |
| `INSIGHTD_ALERTS_ENABLED` | `false` | Enable real-time alerts |
| `INSIGHTD_STATUS_PAGE` | `false` | Enable public status page |
| `INSIGHTD_SMTP_HOST` | — | SMTP server for emails |
| `INSIGHTD_DIGEST_CRON` | `0 8 * * 1` | Digest schedule |
| `INSIGHTD_COLLECT_INTERVAL` | `5` | Collection interval (minutes) |
| `TZ` | `UTC` | Timezone |

See [`.env.example`](https://github.com/goldenproductions/insightd/blob/main/.env.example) for the full list (40+ variables).

## Volumes

| Path | Purpose |
|------|---------|
| `/data` | SQLite database and persistent state |
| `/var/run/docker.sock` | Docker socket (standalone mode only) |
| `/host` | Host filesystem mount (standalone mode only) |

## Architecture

```
[Agents] --> MQTT (Mosquitto) --> [Hub] --> SQLite --> React UI + Alerts + Digests
```

- **Hub mode**: connects to MQTT, receives metrics from agents
- **Standalone mode**: no MQTT, collects locally (single host)

## Resources

- ~28MB RAM typical usage
- SQLite storage, no external database
- Multi-arch: `linux/amd64`, `linux/arm64`

## Links

- [GitHub](https://github.com/goldenproductions/insightd)
- [Agent image](https://hub.docker.com/r/andreas404/insightd-agent)
- [Security policy](https://github.com/goldenproductions/insightd/blob/main/SECURITY.md)
