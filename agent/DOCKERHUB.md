# Insightd Agent

**Lightweight monitoring agent** for [insightd](https://github.com/goldenproductions/insightd). Deploy on each host to collect Docker container and system metrics, reporting back to the central hub via MQTT.

## Quick Start

```bash
docker run -d \
  --name insightd-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /:/host:ro \
  -e INSIGHTD_HOST_ID=my-server \
  -e INSIGHTD_MQTT_URL=mqtt://your-hub-ip:1883 \
  -e INSIGHTD_MQTT_USER=insightd \
  -e INSIGHTD_MQTT_PASS=your-mqtt-password \
  andreas404/insightd-agent:latest
```

The agent will immediately start collecting metrics and publishing to the hub.

> Tip: The hub's **Add Agent** page generates a ready-to-paste `docker run` command with your MQTT details pre-filled.

## What It Collects

| Metric | Details |
|--------|---------|
| **Containers** | Status, CPU, RAM, restarts, network I/O, block I/O, health checks |
| **Host CPU** | Usage, load average |
| **Host memory** | Total, used, available |
| **Disks** | Usage per mount, days-until-full forecast |
| **GPU** | Utilization, memory, temperature (NVIDIA) |
| **Temperature** | CPU/system sensor readings |
| **Disk I/O** | Read/write throughput |
| **Network I/O** | Per-interface bandwidth |

Metrics are collected every 5 minutes (configurable) and published to MQTT.

## Additional Capabilities

- **Container actions** — start/stop/restart containers remotely from the hub UI (opt-in)
- **Log tailing** — fetch container logs on demand from the hub UI
- **Remote updates** — update the agent from the hub UI via MQTT (opt-in)
- **Image update detection** — compares local images against Docker Hub registry

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_HOST_ID` | `local` | Unique name for this host |
| `INSIGHTD_MQTT_URL` | — | MQTT broker URL (required) |
| `INSIGHTD_MQTT_USER` | — | MQTT username |
| `INSIGHTD_MQTT_PASS` | — | MQTT password |
| `INSIGHTD_COLLECT_INTERVAL` | `5` | Collection interval (minutes) |
| `INSIGHTD_ALLOW_ACTIONS` | `false` | Enable container start/stop/restart |
| `INSIGHTD_ALLOW_UPDATES` | `false` | Enable remote agent updates |
| `INSIGHTD_DISK_WARN_THRESHOLD` | `85` | Disk warning threshold (%) |
| `TZ` | `UTC` | Timezone |

## Volumes

| Path | Purpose |
|------|---------|
| `/var/run/docker.sock` | Docker socket (required) |
| `/host` | Host filesystem mount (read-only, for disk/host metrics) |

## Resources

- ~15MB RAM typical usage
- No local storage needed
- Multi-arch: `linux/amd64`, `linux/arm64`

## Links

- [GitHub](https://github.com/goldenproductions/insightd)
- [Hub image](https://hub.docker.com/r/andreas404/insightd-hub)
- [Security policy](https://github.com/goldenproductions/insightd/blob/main/SECURITY.md)
