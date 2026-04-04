# Enhanced Agent Telemetry

> Status: **Implemented**

## What Was Added

| Category | Metrics | Source |
|----------|---------|--------|
| Host system | CPU%, memory, load avg, uptime | /proc/stat, meminfo, loadavg, uptime |
| Container network | RX bytes, TX bytes | Docker stats API |
| Container block I/O | Read bytes, write bytes | Docker stats API |
| Container health | Health status | Docker inspect API |

## Schema v4

New table: `host_snapshots` (cpu_percent, memory_total_mb, memory_used_mb, memory_available_mb, swap, load_1/5/15, uptime_seconds)

New columns on `container_snapshots`: network_rx_bytes, network_tx_bytes, blkio_read_bytes, blkio_write_bytes, health_status

## New Alert Types

- `high_host_cpu` — Host CPU > threshold (default 90%)
- `low_host_memory` — Available memory < threshold (default disabled)
- `high_load` — Load 5min > threshold (default disabled)
- `container_unhealthy` — Health status = unhealthy (default enabled)

## MQTT Payload v2

Added `host` object to collection message. Extended container entries with 5 new fields. Hub handles v1 payloads by checking if fields exist.
