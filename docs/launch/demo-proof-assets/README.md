# insightd demo proof-of-work assets

Captured from the live interactive demo at <https://insightd.org/demo/> on 2026-08-20 using a 1440×1050 light-mode browser viewport.

Use these as the launch proof set for the GitHub README, the insightd.org screenshots section, and the LinkedIn launch post. The screenshots are static mock data from the public demo; do not present them as a real customer or production system.

| Asset | Caption | Primary use |
| --- | --- | --- |
| [`screenshots/01-dashboard-attention-feed.png`](./screenshots/01-dashboard-attention-feed.png) | Fleet health starts with the one thing that needs attention: Jellyfin restart-spamming, backed by memory pressure and recent log context instead of a raw wall of charts. | README lead proof + website screenshots |
| [`screenshots/02-host-metrics.png`](./screenshots/02-host-metrics.png) | The sample workspace mixes Docker, k3s, Proxmox VE, and HTTP endpoints so users can see host pressure and runtime status in one shared fleet view. | Website screenshots + LinkedIn carousel |
| [`screenshots/03-diagnosis-log-evidence.png`](./screenshots/03-diagnosis-log-evidence.png) | When a container is unhealthy, insightd ranks the likely cause, shows confidence, and keeps the exact log pattern and metric/restart/topology evidence beside the next action. | README/LinkedIn proof of “why, not just what” |
| [`screenshots/04-alert-routes.png`](./screenshots/04-alert-routes.png) | Alerts are deduped, routed to Slack and ntfy, and suppressed when they match a known maintenance window so launch readers see calm notification behavior. | Website screenshots + launch copy |
| [`screenshots/05-endpoint-monitoring.png`](./screenshots/05-endpoint-monitoring.png) | HTTP checks live beside infrastructure signals: p95 latency, TLS age, status, and alert-route delivery stay visible without leaving the homelab dashboard. | Website screenshots + LinkedIn carousel |

## Suggested README placement

Use the dashboard/attention screenshot as the first visual proof and link to this folder for the full set. The diagnosis screenshot is the strongest companion image because it proves the positioning claim: insightd explains likely cause and evidence, not only status.

## Suggested insightd.org placement

Replace or lead the `See it in action` screenshot grid with these demo captures so the public site and `/demo/` tell the same story:

1. Dashboard health and attention feed
2. Host metrics across Docker, k3s, and Proxmox
3. Container diagnosis with log evidence
4. Alert routes and calm delivery
5. Endpoint monitoring alongside infrastructure

## Suggested LinkedIn carousel order

1. `01-dashboard-attention-feed.png` — What needs attention?
2. `03-diagnosis-log-evidence.png` — Why did it happen?
3. `02-host-metrics.png` — Which host is under pressure?
4. `04-alert-routes.png` — Who gets alerted, calmly?
5. `05-endpoint-monitoring.png` — Are public endpoints affected?
