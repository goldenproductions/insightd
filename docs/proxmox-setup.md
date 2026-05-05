# Proxmox VE setup

Run insightd-agent natively on a Proxmox VE hypervisor to surface its LXC
containers and QEMU VMs as first-class entries in the hosts/containers UI,
alongside ZFS pool health, storage saturation, cluster quorum, and per-guest
backup/snapshot state. Same agent binary as Docker; no separate package.

## Quick start

1. **Install Node.js 20 on the PVE host** (Proxmox is Debian-based):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   ```

2. **Drop the agent source onto the PVE host** (clone, scp, whatever fits):

   ```bash
   git clone https://github.com/goldenproductions/insightd.git /opt/insightd
   cd /opt/insightd && npm ci --omit=dev
   ```

3. **Create a systemd unit at `/etc/systemd/system/insightd-agent.service`:**

   ```ini
   [Unit]
   Description=insightd agent (Proxmox VE)
   After=network-online.target pve-cluster.service
   Wants=network-online.target

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/opt/insightd
   Environment=INSIGHTD_RUNTIME=proxmox
   Environment=INSIGHTD_HOST_ID=proxmox-01
   Environment=INSIGHTD_HOST_GROUP=home-cluster
   Environment=INSIGHTD_MQTT_URL=mqtt://your-broker:1883
   Environment=INSIGHTD_ALLOW_ACTIONS=true
   ExecStart=/usr/bin/npx tsx agent/src/index.ts
   Restart=on-failure
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```

4. **Enable + start:**

   ```bash
   systemctl daemon-reload
   systemctl enable --now insightd-agent
   journalctl -u insightd-agent -f
   ```

   Within one collection cycle (5 min by default) the PVE node appears on the
   Hosts page with a purple `proxmox` badge and its LXC/QEMU guests show up as
   containers.

## Why root?

`pvesh`, `pct`, and `qm` need root or a custom polkit rule. The agent already
runs as root in Docker mode (it talks to `/var/run/docker.sock`); single-user
homelab posture matches. Containerized deployment isn't supported on PVE —
PVE explicitly discourages running workloads on the hypervisor and Docker
fights with PVE's own LXC tooling.

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `INSIGHTD_RUNTIME` | yes | `auto` | Set to `proxmox`. `auto` also detects PVE via `/etc/pve/.version` if it exists. |
| `INSIGHTD_HOST_ID` | yes | — | Stable identifier (e.g. `proxmox-01`). Used as the host_id throughout the UI. |
| `INSIGHTD_HOST_GROUP` | recommended | — | Cluster name. The hub uses this to associate the host with cluster-scoped data; pick the same value on every node of a cluster. |
| `INSIGHTD_MQTT_URL` | yes | — | mqtt:// URL of your broker. |
| `INSIGHTD_MQTT_USER` / `_PASS` | optional | — | Broker credentials. |
| `INSIGHTD_ALLOW_ACTIONS` | optional | `false` | Enable `pct`/`qm` start/stop/restart/destroy from the UI. Without this, action buttons return an error from the agent. |
| `INSIGHTD_COLLECT_INTERVAL` | optional | `5` | Minutes between collection cycles. |

### `INSIGHTD_RUNTIME=docker` override

If your PVE host *also* runs Docker for utility containers, the runtime
auto-detector picks `proxmox` (single-runtime model). Set `INSIGHTD_RUNTIME=docker`
to flip the priority — you'll lose PVE coverage but keep the Docker view.

## Identity bridge (PR4): linking the in-guest agent to the hypervisor view

If you also run insightd-agent *inside* a VM, you can link the two views so
the UI offers cross-navigation between them. The hypervisor sees the VM as
"VMID 103 on proxmox-01"; the in-guest agent reports under its own host_id
(e.g. `web-1`). Without a hint, the hub can't tell those are the same VM.

Set two env vars on the **in-guest agent** (NOT on the PVE host):

```bash
INSIGHTD_PROXMOX_NODE=proxmox-01    # The PVE node name
INSIGHTD_PROXMOX_VMID=103           # The VMID on PVE
```

Both must be set together; setting only one is a configuration error.

Once configured:

- The PVE container detail page for `proxmox-01/103` shows a **"View in-guest
  metrics →"** link to the in-guest host detail.
- The in-guest host detail shows a **"View hypervisor view →"** link back to
  the PVE container detail.

The two records stay independent — that's deliberate. "The VM is up per PVE
but its in-guest agent stopped reporting 20 minutes ago" is exactly the kind
of signal you want visible.

## What the agent reports

| Source | Surface |
| --- | --- |
| `/cluster/resources` (per cycle) | Per-guest CPU, mem, network, disk I/O, status |
| `/nodes/{node}/storage` | Per-storage usage → `pve_storage_saturation` alert |
| `/nodes/{node}/disks/zfs` | Per-pool health → `pve_zfs_unhealthy` alert |
| `/cluster/status` | Quorate flag → `pve_cluster_quorum_lost` alert |
| `/nodes/{node}/{type}/{vmid}/snapshot` | Per-guest snapshot count → "many snapshots" insight |
| `/cluster/tasks` + `/cluster/backup-info/not-backed-up` | Per-guest backup history → `pve_backup_overdue` alert |
| `/proc/*` and `/sys/*` (Linux native) | Hypervisor-level CPU/mem/load/temps/disk-IO/network-IO |

## Logs

| Guest type | Log fetch path |
| --- | --- |
| LXC | `journalctl --machine=<vmid>` (preferred), falls back to `pct exec <vmid> -- journalctl` |
| QEMU | **Not available from the hypervisor.** The container detail page renders an empty-state pointing at the in-guest agent. |

## Actions (`INSIGHTD_ALLOW_ACTIONS=true`)

| Action | LXC | QEMU |
| --- | --- | --- |
| Start | `pct start <vmid>` | `qm start <vmid>` |
| Stop  | `pct shutdown <vmid>` (graceful, ACPI) | `qm shutdown <vmid>` (graceful, ACPI) |
| Restart | `pct reboot <vmid>` | `qm reboot <vmid>` (requires guest agent or ACPI-aware OS) |
| Remove | `pct destroy <vmid>` (refuses if running) | `qm destroy <vmid>` (refuses if running) |

Stop/restart on QEMU need either the guest's qemu-guest-agent or a kernel
that responds to ACPI. Without either, `shutdown`/`reboot` will time out
silently from the agent's perspective — PVE returns success but the VM
keeps running. There's no way around this from the hypervisor side.

## Troubleshooting

- **"ProxmoxRuntime init failed: spawn /usr/bin/pvesh ENOENT"** — pvesh isn't
  on `$PATH`. On a stock PVE install it's at `/usr/bin/pvesh`; check that
  the systemd unit's `Environment=PATH=...` (or unset) includes `/usr/bin`.
- **"PVE guest vmid=X not found on node Y"** when triggering an action — the
  guest was migrated to another node between the action request and its
  execution. Refresh the UI; the guest should now appear under the new node's
  hosts page.
- **Cluster quorum alert keeps firing on a single-node install** — shouldn't
  happen; standalone PVE doesn't publish a cluster-status row at all. If it
  does, check `pvesh get /cluster/status --output-format json` and confirm
  there's no `type:'cluster'` row.
