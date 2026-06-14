# Contributing

Thanks for taking an interest in insightd. This file covers the day-to-day basics; for product context and conventions see `CLAUDE.md` (which doubles as a high-level design doc).

## Setup

Requires Node.js 20 + Docker.

```bash
git clone https://github.com/goldenproductions/insightd
cd insightd
npm install
cd hub/src/web/frontend && npm install && cd -
```

## Run the checks

```bash
npm test            # ~1200 tests via node:test, no external deps
npm run typecheck   # tsc --noEmit, strict mode
cd hub/src/web/frontend && npm run build   # frontend type/build check
```

CI runs all three on every push. Please make sure they pass locally before opening a pull request.

## Run the stack locally

```bash
docker compose up -d                     # mosquitto + hub + agent
curl http://localhost:3000/api/health    # smoke check
```

To iterate on the hub without a full release, see the vdev loop documented in `CLAUDE.md` (build the `:vdev` image and recreate the hub container with the local override file).

## Filing a bug

Use the bug-report issue template. Triage almost always needs:

- Hub + agent versions
- Runtime: Docker / Kubernetes / Proxmox VE
- Host OS
- Steps to reproduce
- `docker logs insightd-hub --tail 200` (and the agent log if relevant)

Security issues — please use GitHub's private vulnerability reporting (see `SECURITY.md`), not a public issue.

## Pull requests

- Branch from `main`. Feature branches and PRs for substantial changes; direct-to-main only for small fixes (typos, comment edits).
- One logical change per PR. If the change touches both hub and agent, that's fine — they ship as a coordinated pair.
- Match the existing commit style: `feat:` / `fix:` / `docs:` / `chore:` prefixes are common but not strictly enforced. PR titles end with the merged number (`(#NNN)`) automatically on squash-merge.
- The PR template asks for a one-paragraph summary and a test plan. Even a manual "I clicked through the dashboard and saw X work" is useful.
- Tests are required for non-trivial backend logic (anything in `hub/src/insights/`, `hub/src/web/queries.ts`, `hub/src/alerts/`). Frontend changes are typically validated via `npm run build` + a manual walk-through on a `:vdev` deploy.

## Releases

Releases are cut by maintainers via tags: `hub-vX.Y.Z` and `agent-vX.Y.Z` independently trigger the publish workflows in `.github/workflows/`. Hub and agent versions are not coupled; a hub release without an agent change just bumps the hub.

Use [`docs/release-checklist.md`](./docs/release-checklist.md) before tagging a public release so tests, Docker smoke checks, Quick Start validation, release notes, and post-release verification happen consistently.

## Where things live

```
agent/             # Agent — collectors, MQTT publisher, runtime adapters
hub/src/           # Hub — DB, insights engine, alert evaluator, MQTT subscriber
hub/src/web/       # HTTP server + handlers
hub/src/web/frontend/  # React + Vite SPA
shared/            # Used by both agent and hub
src/               # Standalone-mode entrypoint (Docker only)
tests/             # node:test suites (unit + integration)
docs/              # Setup guides surfaced on docs.insightd.org
```

## Questions

For usage questions or design discussion, use [GitHub Discussions](https://github.com/goldenproductions/insightd/discussions) rather than opening an issue.
