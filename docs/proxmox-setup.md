# Proxmox VE setup

Run insightd-agent against a Proxmox VE hypervisor to surface its LXC
containers and QEMU VMs as first-class entries in the hosts/containers UI,
alongside ZFS pool health, storage saturation, cluster quorum, and per-guest
backup/snapshot state.

The agent has two transports for talking to PVE:

- **REST API mode (recommended)** — agent runs from a guest VM (or anywhere
  with reachability to PVE's web port), authenticates with an API token. No
  install on the hypervisor.
- **Bare-metal install (alternative)** — agent runs on the PVE host itself
  and shells out to local `pvesh` / `pct` / `qm`. Full LXC log support but
  requires Node 20 + the agent source on the hypervisor.

REST mode is the path most homelabbers want. The bare-metal install is
documented in the appendix at the bottom for users who explicitly want
on-host operation (full LXC log support).

## Quick start (REST API mode)

### 1. Create a PVE API token

In the PVE UI: Datacenter → Permissions → API Tokens → Add. Pick a user (or
create one — `insightd@pve` is a fine convention), set Token ID `agent01`,
leave **Privilege Separation enabled**, save. Copy the secret immediately —
PVE only shows it once.

Or via CLI on the PVE host:

```bash
pveum user add insightd@pve
pveum user token add insightd@pve agent01 --privsep 1
# secret is printed once — copy it
```

### 2. Grant the token permissions

The token needs read access to everything insightd reports on, plus power-
management for actions:

```bash
pveum acl modify / --tokens 'insightd@pve!agent01' --roles 'PVEAuditor,PVEVMAdmin'
```

`PVEAuditor` covers all the read paths (cluster status, node disks/storage,
VM listings, task log). `PVEVMAdmin` adds `VM.PowerMgmt` (start / stop /
reboot) and `VM.Allocate` (destroy). Drop `PVEVMAdmin` if you only want
read-only monitoring.

### 3. Run the agent on any guest VM

The agent is a Node 20 app — anywhere you can run Node and reach PVE's
:8006 from will work. systemd unit example:

```ini
# /etc/systemd/system/insightd-agent.service
[Unit]
Description=insightd agent (Proxmox REST API mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=insightd
WorkingDirectory=/opt/insightd
Environment=INSIGHTD_RUNTIME=proxmox
Environment=INSIGHTD_HOST_ID=proxmox-01
Environment=INSIGHTD_HOST_GROUP=home-cluster
Environment=INSIGHTD_MQTT_URL=mqtt://your-broker:1883
Environment=INSIGHTD_PVE_API_URL=https://proxmox-01.lan:8006
Environment=INSIGHTD_PVE_TOKEN_ID=insightd@pve!agent01
Environment=INSIGHTD_PVE_TOKEN_SECRET=PASTE-THE-SECRET-FROM-STEP-1
Environment=INSIGHTD_PVE_NODE=proxmox-01
Environment=INSIGHTD_ALLOW_ACTIONS=true
ExecStart=/usr/bin/npx tsx agent/src/index.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Note we do *not* run as root — REST mode doesn't need it. Pick any user that
can read the agent source.

```bash
systemctl daemon-reload
systemctl enable --now insightd-agent
journalctl -u insightd-agent -f
```

Within ~5 min the PVE node appears on the Hosts page with the purple `proxmox`
badge and its LXC/QEMU guests show up as containers.

## REST mode environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `INSIGHTD_RUNTIME` | yes | `auto` | Set explicitly to `proxmox`. Auto-detect only triggers on the bare-metal install path; REST-mode users from a guest must set it. |
| `INSIGHTD_HOST_ID` | yes | — | Stable identifier for the PVE node. Used as the host_id throughout the UI. |
| `INSIGHTD_HOST_GROUP` | recommended | — | Cluster name. Pick the same value on every node-agent of one cluster. |
| `INSIGHTD_MQTT_URL` | yes | — | mqtt:// URL of your broker. |
| `INSIGHTD_PVE_API_URL` | yes | — | `https://hostname:8006`. The presence of this var is what selects REST mode. |
| `INSIGHTD_PVE_TOKEN_ID` | yes | — | Format `user@realm!tokenid`, e.g. `insightd@pve!agent01`. |
| `INSIGHTD_PVE_TOKEN_SECRET` | yes | — | The secret PVE shows once on token creation. |
| `INSIGHTD_PVE_NODE` | yes | — | The PVE node this agent monitors. Required because there's no "local" node when reading remotely. |
| `INSIGHTD_PVE_VERIFY_TLS` | optional | `false` | Default off because most PVE installs use the auto-generated self-signed cert. Set `true` once you've configured Let's Encrypt or pinned a CA. |
| `INSIGHTD_PVE_CA_BUNDLE` | optional | — | Path to a PEM CA bundle. Only consulted when `INSIGHTD_PVE_VERIFY_TLS=true`. |
| `INSIGHTD_ALLOW_ACTIONS` | optional | `false` | Enable start / stop / restart / destroy from the UI. Without this, action buttons return a clear error from the agent. |
| `INSIGHTD_COLLECT_INTERVAL` | optional | `5` | Minutes between collection cycles. |

### Multi-node clusters

The agent monitors **one PVE node per process** (mirrors the bare-metal
model). For a 3-node cluster, run 3 agent processes from one VM, each with
its own `INSIGHTD_HOST_ID` and `INSIGHTD_PVE_NODE`. They can share the same
API token (or get one each for audit clarity).

```ini
Environment=INSIGHTD_HOST_ID=proxmox-01
Environment=INSIGHTD_PVE_NODE=proxmox-01

# … and a separate systemd unit for proxmox-02:
Environment=INSIGHTD_HOST_ID=proxmox-02
Environment=INSIGHTD_PVE_NODE=proxmox-02
```

## What the agent reports

| Source endpoint | Surface |
| --- | --- |
| `/cluster/resources` (per cycle) | Per-guest CPU, mem, network, disk I/O, status |
| `/nodes/{node}/storage` | Per-storage usage → `pve_storage_saturation` alert |
| `/nodes/{node}/disks/zfs` | Per-pool health → `pve_zfs_unhealthy` alert |
| `/cluster/status` | Quorate flag → `pve_cluster_quorum_lost` alert |
| `/nodes/{node}/{type}/{vmid}/snapshot` | Per-guest snapshot count → "many snapshots" insight |
| `/cluster/tasks` + `/cluster/backup-info/not-backed-up` | Per-guest backup history → `pve_backup_overdue` alert |

## Actions (`INSIGHTD_ALLOW_ACTIONS=true`)

| Action | LXC | QEMU |
| --- | --- | --- |
| Start | `POST /…/lxc/<vmid>/status/start` | `POST /…/qemu/<vmid>/status/start` |
| Stop | `POST /…/lxc/<vmid>/status/shutdown` (graceful, ACPI) | `POST /…/qemu/<vmid>/status/shutdown` (graceful, ACPI) |
| Restart | `POST /…/lxc/<vmid>/status/reboot` | `POST /…/qemu/<vmid>/status/reboot` (needs guest agent or ACPI-aware OS) |
| Remove | `DELETE /…/lxc/<vmid>` (PVE refuses if running) | `DELETE /…/qemu/<vmid>` (PVE refuses if running) |

REST actions are fire-and-forget: the agent returns success once PVE accepts
the request (with the task UPID surfaced in the message), then the next
collection cycle reflects the new state. If the guest ignores ACPI for
shutdown / reboot, no error fires — same as `pct shutdown` doesn't fail when
the guest doesn't comply.

## Logs (REST mode caveat)

REST mode does **not** support log fetch. The container detail Logs tab
renders an empty state pointing at the in-guest agent for both LXC and QEMU.

Why: PVE's `/exec` REST endpoint is async-streaming and only useful with
`VM.Console` permission, which broadens the token's blast radius
considerably. The "install insightd-agent inside the guest" path was the
better answer for QEMU even on bare-metal install, and it remains the
recommendation here.

If you need the host-side `journalctl --machine=<vmid>` LXC log path (works
for unprivileged systemd LXCs), use the bare-metal install in the appendix.

## Identity bridge: linking the in-guest agent to the hypervisor view

If you also run insightd-agent *inside* a VM, you can link the two views so
the UI offers cross-navigation between them. The hypervisor sees the VM as
"VMID 103 on proxmox-01"; the in-guest agent reports under its own host_id
(e.g. `web-1`). Without a hint, the hub can't tell those are the same VM.

Set two env vars on the **in-guest agent** (NOT on the agent talking to PVE):

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

The bridge env vars are **separate** from `INSIGHTD_PVE_*` vars: the bridge
goes on the in-guest agent pointing back at PVE; the API vars go on the
agent talking *to* PVE (typically a different process on a different host).

## Troubleshooting

- **"REST mode requires INSIGHTD_PVE_NODE…"** — set it. The agent won't
  guess which node to monitor from a remote viewpoint.
- **"INSIGHTD_PVE_NODE='typo' not found in cluster. Known nodes: …"** —
  fix the node name to match what `pvesh get /nodes` lists.
- **"PVE API GET … returned 401"** — token id or secret is wrong, or the
  token doesn't exist anymore. Recreate via `pveum user token list insightd@pve`.
- **"PVE API … returned 403"** — the token's role doesn't include the needed
  permission. For actions, you need `PVEVMAdmin` (or at least `VM.PowerMgmt`).
- **"PVE API … returned 595" (TLS error)** — your PVE cert isn't trusted
  by the agent's Node runtime. Either set `INSIGHTD_PVE_VERIFY_TLS=false`
  (default) or point `INSIGHTD_PVE_CA_BUNDLE` at the right CA PEM.
- **Cluster quorum alert keeps firing on a single-node install** — shouldn't
  happen; standalone PVE doesn't publish a cluster row. Check
  `pvesh get /cluster/status --output-format json` and confirm there's no
  `type:'cluster'` row.

---

## Appendix: bare-metal install on the PVE hypervisor

This was the original install path before REST API mode existed. Choose this
over REST mode only if you specifically want LXC log fetch via `journalctl
--machine` / `pct exec`. Trade-off: Node 20 + the agent source live on the
hypervisor.

### 1. Install Node 20 on the PVE host (it's Debian-based)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
```

### 2. Drop the agent source onto the PVE host

```bash
git clone https://github.com/goldenproductions/insightd.git /opt/insightd
cd /opt/insightd && npm ci --omit=dev
```

### 3. Systemd unit at `/etc/systemd/system/insightd-agent.service`

```ini
[Unit]
Description=insightd agent (Proxmox VE, bare-metal)
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

```bash
systemctl daemon-reload
systemctl enable --now insightd-agent
journalctl -u insightd-agent -f
```

The bare-metal path runs as root because `pvesh`, `pct`, and `qm` need root
or a polkit rule. The agent already runs as root in Docker mode (it talks
to `/var/run/docker.sock`); single-user homelab posture matches.

The runtime auto-detects PVE via `/etc/pve/.version`, so even
`INSIGHTD_RUNTIME=auto` works — but explicit is clearer in a unit file.

### `INSIGHTD_RUNTIME=docker` override on a Docker-on-PVE host

If your PVE host *also* runs Docker for utility containers, the runtime
auto-detector picks `proxmox` (single-runtime model). Set
`INSIGHTD_RUNTIME=docker` to flip the priority — you'll lose PVE coverage
but keep the Docker view.
