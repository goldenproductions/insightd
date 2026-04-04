# Independent Agent/Hub Versioning

> Status: **Implemented** (v0.3.0+)

## Context
Agent and hub are independently deployable Docker images but shared a single version. Splitting allows updating one without touching the other.

## Changes

1. **Split CI**: Separate workflows — `publish-hub.yml` (triggers on `hub-v*` tags), `publish-agent.yml` (triggers on `agent-v*` tags)
2. **Version check**: `fetchLatestTag(repo)` queries both `insightd-hub` and `insightd-agent` independently
3. **Backend handlers**: `handleUpdateAgent` uses `latestAgentVersion`, `handleUpdateHub` uses `latestHubVersion`
4. **Frontend**: UpdatesPage and UpdateBanner show separate hub/agent versions

## Key Decisions

- Keep `INSIGHTD_VERSION` env var name in both Dockerfiles (separate containers, no collision)
- Both started at v0.3.0
- Current: hub-v0.4.0, agent-v0.4.0
