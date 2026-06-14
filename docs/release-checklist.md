# Release checklist

Use this checklist when preparing a public insightd release. The goal is to ship a release that is understandable, installable, and easy to roll back from — not just to push tags.

## 1. Decide what is shipping

- [ ] Pick release scope: hub, agent, or both.
- [ ] Confirm the target version(s), for example `hub-v0.24.1` and/or `agent-v0.24.1`.
- [ ] Review merged PRs since the last relevant tag.
- [ ] Identify any user-facing behavior changes that need release notes.
- [ ] Confirm no launch-blocking docs placeholders remain in `README.md`, install docs, or the website.

Useful commands:

```bash
git fetch --tags
git tag --list 'hub-v*' --sort=-v:refname | head
git tag --list 'agent-v*' --sort=-v:refname | head
git log --oneline <previous-tag>..HEAD
```

## 2. Run local quality gates

- [ ] Install dependencies from a clean checkout or after pulling latest `main`.
- [ ] Run backend/unit/integration tests.
- [ ] Run TypeScript typecheck.
- [ ] Build the frontend.

Commands:

```bash
npm install
npm test
npm run typecheck
cd hub/src/web/frontend && npm install && npm run build
```

## 3. Smoke test Docker Compose

- [ ] Build local images.
- [ ] Start the stack with Docker Compose.
- [ ] Verify the hub health endpoint responds.
- [ ] Open the UI and complete or verify the setup wizard path.
- [ ] Confirm the local agent appears in the UI within the expected interval.
- [ ] Check hub, agent, and Mosquitto logs for startup errors.

Commands:

```bash
docker compose build
docker compose up -d
curl -fsS http://localhost:3000/api/health
docker compose logs --tail=100 hub agent mosquitto
docker compose down
```

## 4. Validate Quick Start from a clean host

Before a public release, test the user path on a clean Linux VM with Docker and Compose v2 installed.

- [ ] Run the install command exactly as documented.
- [ ] Confirm `~/insightd/.env` is created with owner-only permissions.
- [ ] Confirm `docker compose ps` shows hub, agent, and Mosquitto running.
- [ ] Confirm the hub health endpoint responds.
- [ ] Open the setup wizard and create the first admin user.
- [ ] Confirm the local agent appears in the UI.
- [ ] Record anything confusing or broken and fix docs before tagging.

Command:

```bash
curl -sSL https://insightd.org/install.sh | bash
```

## 5. Review trust and security-sensitive docs

- [ ] Confirm the README explains that insightd is self-hosted and SQLite-backed.
- [ ] Confirm the install script is linked so users can audit before running it.
- [ ] Confirm MQTT is described as a private network/VPN component, not something to expose publicly.
- [ ] Confirm Docker socket, Kubernetes RBAC, Proxmox token permissions, email credentials, and webhook credentials are documented if they changed.
- [ ] Confirm `SECURITY.md` still points users to private vulnerability reporting.

## 6. Prepare release notes

Write notes for humans, not just a changelog dump.

Include:

- [ ] One-sentence summary of the release.
- [ ] What changed for homelab users.
- [ ] Any install, upgrade, or configuration changes.
- [ ] Known rough edges.
- [ ] Links to Quick Start and early-user feedback discussion.

Suggested structure:

```markdown
## Summary

## Highlights

## Upgrade notes

## Fixes and polish

## Known rough edges

## Feedback wanted
```

## 7. Tag and publish

Only tag from the commit that passed the checks above.

- [ ] Ensure the working tree is clean.
- [ ] Push `main`.
- [ ] Create the relevant tag(s).
- [ ] Push the tag(s) to trigger Docker Hub publish workflows.
- [ ] Watch GitHub Actions until the publish jobs pass.
- [ ] Verify the Docker Hub image tags exist for the expected architectures.

Commands:

```bash
git status --short
git push origin main
git tag hub-vX.Y.Z
git push origin hub-vX.Y.Z
# If the agent changed:
git tag agent-vX.Y.Z
git push origin agent-vX.Y.Z
```

## 8. Post-release verification

- [ ] Pull the published image(s) on a test host.
- [ ] Run the Quick Start or upgrade path against the published tag(s).
- [ ] Confirm the UI shows the expected version(s).
- [ ] Confirm alerts/digests/webhooks still work if they were touched.
- [ ] Update README/docs version references if needed.
- [ ] Publish GitHub release notes.
- [ ] Publish or schedule the launch/update post.

## 9. Rollback notes

Before announcing widely, know the rollback path:

- [ ] Identify the previous known-good hub tag.
- [ ] Identify the previous known-good agent tag.
- [ ] Confirm whether the release included database migrations.
- [ ] If migrations are not reversible, note that rollback may require restoring the SQLite backup.
- [ ] Keep the announcement honest about any known rough edges.
