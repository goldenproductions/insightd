# LinkedIn launch post draft

I built insightd because I wanted homelab monitoring that answers the question I actually have at 21:00:

“Why is this broken, and what should I check next?”

The public interactive demo is now live: https://insightd.org/demo/

It walks through a sample mixed homelab with Docker, k3s, Proxmox VE, HTTP endpoints, alerts, and diagnosis evidence. The story is intentionally concrete:

- Dashboard health starts with the attention feed, not a blank wall of charts.
- Host metrics show which machine is under pressure across Docker, k3s, and Proxmox.
- Container diagnosis ranks the likely cause and keeps log evidence next to suggested actions.
- Alerts route to Slack + ntfy with dedupe/suppression so notifications stay calm.
- Endpoint checks live alongside infrastructure state so you can see whether users are affected.

Insightd is self-hosted, stores monitoring data locally in SQLite, and is designed for homelabbers who want useful server awareness without assembling a full Prometheus/Grafana/Loki stack.

Try the demo before installing: https://insightd.org/demo/
Install guide: https://docs.insightd.org/guides/quick-start/
GitHub: https://github.com/goldenproductions/insightd

I’m especially looking for first-user feedback:
- Did the install work on the first try?
- What environment did you use?
- What felt trustworthy or confusing in the diagnosis flow?

#selfhosted #homelab #monitoring #opensource #docker #kubernetes #proxmox

## Carousel assets

Use this order from `docs/launch/demo-proof-assets/screenshots/`:

1. `01-dashboard-attention-feed.png` — “What needs attention?”
2. `03-diagnosis-log-evidence.png` — “Why did it happen?”
3. `02-host-metrics.png` — “Which host is under pressure?”
4. `04-alert-routes.png` — “Who gets alerted, calmly?”
5. `05-endpoint-monitoring.png` — “Are public endpoints affected?”
