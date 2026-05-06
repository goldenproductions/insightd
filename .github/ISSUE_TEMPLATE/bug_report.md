---
name: Bug report
about: Report a problem with insightd
labels: bug
---

<!-- Thanks for taking the time to file a bug. The more of the below you fill in,
the faster we can help. Anything you don't know, leave blank or say so. -->

### What happened

<!-- One or two sentences. What did you see, where did you see it? -->

### What you expected to happen

### Steps to reproduce

1.
2.
3.

### Versions and environment

- **Hub version**: <!-- e.g. hub-v0.21.0; check `docker exec insightd-hub cat /app/hub/package.json | grep version` or the bottom of the dashboard -->
- **Agent version**: <!-- e.g. agent-v0.17.0 -->
- **Runtime**: <!-- Docker / Kubernetes / Proxmox VE / standalone -->
- **Host OS**: <!-- e.g. Ubuntu 24.04, Debian 12, Proxmox VE 8.4, k3s 1.31 -->
- **Browser** (if a UI bug): <!-- Firefox 130 / Chrome 130 / Safari 18 -->

### Logs

<details>
<summary>Hub logs (`docker logs insightd-hub --tail 200`)</summary>

```
paste here
```

</details>

<details>
<summary>Agent logs (`docker logs insightd-agent --tail 200`)</summary>

```
paste here if relevant
```

</details>

### Screenshots

<!-- If the bug is in the UI, a screenshot of the affected page is enormously helpful. -->

### Anything else

<!-- Network setup, reverse proxy, recent upgrades, anything that might be load-bearing context. -->
