# Privacy and security model

Insightd is designed for self-hosted homelabs. It gives useful visibility into hosts, containers, Kubernetes nodes/pods, Proxmox guests, and HTTP endpoints, but it also needs access to operational data. This page explains the trust model and the permissions you should think about before installing it.

## Short version

- Insightd is self-hosted; there is no hosted insightd cloud service required for normal operation.
- Data is stored locally by the hub in SQLite.
- The hub, agent, and Mosquitto broker are intended to run on your own network or VPN.
- MQTT should not be exposed directly to the public internet.
- No telemetry is required for insightd to operate.
- Optional integrations such as email, webhooks, and AI diagnosis only run when you configure them.

## What data is collected

Depending on what you enable, insightd can collect and store:

- host metrics such as CPU, memory, disk, network, uptime, and load
- container, pod, LXC, QEMU, and endpoint status
- container or pod logs requested through the UI or used for diagnosis
- restart history and health-check output
- insight, alert, and feedback metadata
- alert delivery settings such as email or webhook configuration

This information can reveal service names, hostnames, internal URLs, error messages, and operational patterns. Treat the hub database and backups as sensitive operational data.

## Local storage

The hub uses SQLite for local persistence. Keep the database and its backups private. If you copy the database for debugging, redact sensitive hostnames, URLs, logs, tokens, and credentials first.

## Network model

The typical multi-host setup is:

```text
agent(s) -> MQTT broker -> hub -> web UI / email / webhooks
```

Recommended network posture:

- Keep the hub UI behind your LAN, VPN, reverse proxy auth, or another access control layer appropriate for your setup.
- Keep Mosquitto/MQTT private to your LAN or VPN.
- Do not expose MQTT directly to the public internet.
- Use firewall rules so only expected agents can reach the broker.
- Use HTTPS at your reverse proxy if you expose the UI outside localhost/LAN.

## Docker permissions

Docker monitoring usually requires access to the Docker socket. The Docker socket is highly privileged: software with write-capable Docker socket access can often control containers and may effectively gain root-equivalent power on the host.

Practical guidance:

- Only deploy the agent on hosts you trust insightd to observe.
- Keep `INSIGHTD_ALLOW_ACTIONS=false` unless you deliberately want start/stop/restart actions from the UI.
- Keep `INSIGHTD_ALLOW_UPDATES=false` unless you deliberately want remote agent updates.
- Prefer least-privilege network exposure even if the tool itself is local.

## Kubernetes permissions

The Kubernetes/k3s agent runs as a DaemonSet and uses Kubernetes APIs plus kubelet metrics to observe nodes and pods.

Practical guidance:

- Review the RBAC manifest before applying it.
- Keep permissions read-only unless a future feature explicitly requires otherwise.
- Scope the deployment to the clusters you actually want to monitor.
- Treat pod names, namespaces, events, and logs as sensitive if they reveal application or customer data.

## Proxmox VE permissions

The Proxmox adapter reports LXC/QEMU guests, storage, backups, ZFS pools, and cluster signals.

Practical guidance:

- Use an API token rather than a personal administrator password.
- Prefer a dedicated Proxmox user/token for insightd.
- Grant only the permissions needed for monitoring the nodes and guests you want insightd to see.
- Rotate the token if it is copied into logs, issues, screenshots, or support requests.

## Email and webhooks

Email digests, alert delivery, and webhooks are optional.

Practical guidance:

- Use dedicated SMTP credentials when possible.
- Use dedicated webhook URLs for Slack, Discord, Telegram, ntfy, or generic integrations.
- Treat webhook URLs as secrets; anyone with the URL may be able to post to that destination.
- Redact webhook URLs, SMTP usernames/passwords, and message payloads before sharing logs.

## Optional AI diagnosis

The optional "Diagnose with AI" feature requires a configured Gemini API key. It is not required for the built-in diagnosis engine.

If you enable it, assume relevant diagnosis context may be sent to the configured AI provider. Do not enable it for logs or environments where sending operational context to that provider would violate your expectations or policies.

## Install script auditability

The quick install command downloads and runs a shell script:

```bash
curl -sSL https://insightd.org/install.sh | bash
```

If you prefer to audit before running it, read the script first:

```bash
curl -fsSL https://insightd.org/install.sh
```

The install script is also public on GitHub from the README link.

## Reporting vulnerabilities

Please do not open public GitHub issues for security vulnerabilities. Use GitHub private vulnerability reporting as described in `SECURITY.md`.
