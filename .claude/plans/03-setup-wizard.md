# First-Time Setup Wizard

> Status: **Implemented** (v0.4.0)

## Context
New users install insightd, open the web UI, and see a dashboard full of zeros. The wizard provides a guided onboarding experience.

## Steps

1. **Welcome** — brief tagline, "Get Started" button
2. **Admin Password** — set password (stored in settings DB, not just env var)
3. **Email** (optional) — SMTP config with test button
4. **Add First Agent** — docker run command with copy button
5. **Waiting for Data** — polls /api/hosts every 3s, shows animated spinner until agent connects
6. **Done** — summary, "Go to Dashboard" button, sets setup_complete flag

## Backend

- `GET /api/setup/status` — returns setupComplete, mode, authEnabled (no auth required)
- `POST /api/setup/password` — set admin password during setup (locked after complete)
- `POST /api/setup/complete` — mark setup as done
- Auth reads password from settings DB first, env var second
- `setup_complete` stored in meta table; existing installs auto-set to true via migration
