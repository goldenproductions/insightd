# Insightd Agent

**Lightweight monitoring agent** for [insightd](https://github.com/goldenproductions/insightd). Deploy on each host or k8s node to collect container and system metrics, reporting back to the central hub via MQTT.

Supports two runtimes:
- **Docker** — auto-detected via the docker socket (default)
- **Kubernetes** — runs as a DaemonSet, one pod per node, uses kubelet stats

## Quick Start (Docker)

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

## Quick Start (Kubernetes / k3s)

Run as a DaemonSet — see [`agent/k8s/`](https://github.com/goldenproductions/insightd/tree/main/agent/k8s) for the manifests and [`docs/kubernetes-setup.md`](https://github.com/goldenproductions/insightd/blob/main/docs/kubernetes-setup.md) for the full guide.

```bash
kubectl apply -f https://raw.githubusercontent.com/goldenproductions/insightd/main/agent/k8s/rbac.yaml
kubectl apply -f https://raw.githubusercontent.com/goldenproductions/insightd/main/agent/k8s/daemonset.yaml
```

Edit the DaemonSet first to set `INSIGHTD_MQTT_URL` (and optionally `INSIGHTD_HOST_GROUP`). K8s mode is read-only — container actions and image update checks aren't supported (those are managed by the cluster).

## What It Collects

| Metric | Docker mode | Kubernetes mode |
|--------|-------------|-----------------|
| **Containers** | Status, CPU, RAM, restarts, network I/O, block I/O, health checks | Same — sourced from kubelet cAdvisor |
| **Host CPU** | `/proc/stat` | kubelet `/stats/summary` |
| **Host memory** | `/proc/meminfo` | kubelet `/stats/summary` + Node API capacity |
| **Host uptime** | `/proc/uptime` | Node `metadata.creationTimestamp` |
| **Disks** | Usage per mount, days-until-full forecast | Same |
| **GPU** | Utilization, memory, temperature (NVIDIA) | Not collected |
| **Temperature** | CPU/system sensor readings | Not collected |
| **Disk I/O** | Read/write throughput | Not collected |
| **Network I/O** | Per-interface bandwidth | Not collected |
| **Load average** | `/proc/loadavg` | Not collected (kernel concept that doesn't map to a single node) |

Metrics are collected every 5 minutes (configurable) and published to MQTT. In k8s mode, the values that aren't collected appear as `null` rather than misleading numbers — `/proc` and `/sys` inside the agent pod reflect the underlying machine's kernel, not the node.

## Additional Capabilities

- **Container actions** — start/stop/restart containers remotely from the hub UI (opt-in)
- **Log tailing** — fetch container logs on demand from the hub UI
- **Remote updates** — update the agent from the hub UI via MQTT (opt-in)
- **Image update detection** — compares local images against Docker Hub registry

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INSIGHTD_HOST_ID` | `local` | Unique name for this host |
| `INSIGHTD_HOST_GROUP` | — | Optional logical group label (e.g. `production`, `basement`) for the Hosts page |
| `INSIGHTD_RUNTIME` | `auto` | Container runtime: `auto`, `docker`, or `kubernetes` |
| `INSIGHTD_MQTT_URL` | — | MQTT broker URL (required) |
| `INSIGHTD_MQTT_USER` | — | MQTT username |
| `INSIGHTD_MQTT_PASS` | — | MQTT password |
| `INSIGHTD_COLLECT_INTERVAL` | `5` | Collection interval (minutes) |
| `INSIGHTD_ALLOW_ACTIONS` | `false` | Enable container start/stop/restart (Docker mode) |
| `INSIGHTD_ALLOW_UPDATES` | `false` | Enable remote agent updates (Docker mode) |
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
