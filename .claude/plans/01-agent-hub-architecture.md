# Insightd Agent + Hub Architecture

> Status: **Implemented** (v0.2.0+)

## Context
Split insightd from a single container into agents (collect + push) and a hub (aggregate + notify) connected via MQTT.

## Architecture

```
[Host 1]                    [Host 2]                    [Hub Host]
insightd-agent  ──MQTT──►  insightd-agent  ──MQTT──►   Mosquitto
     │                           │                        │
     └──► Docker socket          └──► Docker socket       ▼
                                                    insightd-hub
                                                        │
                                                        ├──► SQLite (all hosts)
                                                        ├──► Digest emails
                                                        └──► Alert emails
```

- **Agent**: lightweight, collects Docker/host metrics, publishes to MQTT
- **Hub**: subscribes to MQTT, stores in SQLite, sends all notifications
- **Mosquitto**: message broker, persists messages so data survives hub downtime
- **Standalone mode**: if no MQTT configured, hub runs collectors locally (backwards compatible)

## MQTT Design

- **Broker**: Mosquitto 2 (Eclipse), ~5MB RAM, persistent sessions
- **Auth**: Username/password (INSIGHTD_MQTT_USER / INSIGHTD_MQTT_PASS)
- **QoS**: 1 (at least once delivery — hub deduplicates by timestamp)
- **Topics**: `insightd/{host_id}/collection`, `insightd/{host_id}/updates`

## Implementation Phases

1. Schema v3 + host_id on all tables
2. Refactor collectors to pure functions (return data, no DB writes)
3. MQTT publisher (agent)
4. MQTT subscriber (hub)
5. Hub entry point + standalone mode
6. Multi-host digest template
7. Docker Compose + Mosquitto setup
