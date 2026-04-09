# Kubernetes / k3s Setup

Insightd's agent runs as a DaemonSet on Kubernetes (and k3s), with one
agent pod per node. Each agent reports its node as a separate "host" to
the hub, and the pods running on that node appear as "containers".

## Quick start

1. **Deploy the hub** somewhere (k8s or another machine). The hub does not
   need to run inside the cluster — it just needs an MQTT broker the agents
   can reach.

2. **Edit `agent/k8s/daemonset.yaml`** and set your MQTT broker URL in the
   `INSIGHTD_MQTT_URL` env var:

   ```yaml
   - name: INSIGHTD_MQTT_URL
     value: mqtt://your-broker.example.com:1883
   ```

3. **Optional: Create an MQTT credentials secret** if your broker requires auth:

   ```bash
   kubectl create namespace insightd
   kubectl create secret generic insightd-mqtt \
     --namespace insightd \
     --from-literal=username=insightd \
     --from-literal=password=yourpassword
   ```

4. **Apply the manifests**:

   ```bash
   kubectl apply -f agent/k8s/rbac.yaml
   kubectl apply -f agent/k8s/daemonset.yaml
   ```

5. **Verify the agents are running**:

   ```bash
   kubectl get pods -n insightd
   kubectl logs -n insightd -l app=insightd-agent
   ```

## What you'll see

- **One host per node** in the insightd UI, named after the node
- **Each pod's containers** appear as containers under that host
- **Container names** use the format `{namespace}/{pod-name}/{container-name}` (stable across pod rollouts — derived from owner references, so consecutive Deployment/ReplicaSet pods share one entry)
- **Per-container metrics** (CPU, memory, network, fs I/O) from the kubelet's cAdvisor endpoint (`/metrics/cadvisor`)
- **Per-node host metrics** (CPU%, memory used/available/total, uptime) from the kubelet's `/stats/summary` endpoint plus the Node API for total capacity
- **Restart count** directly from the pod status
- **Logs** via the Kubernetes API

## What gets reported as NULL in k8s mode (and why)

`/proc/*` and `/sys/*` inside the agent pod reflect the underlying machine's kernel — not the node the agent reports on. Reading them would give the wrong values, so insightd explicitly suppresses them in k8s mode:

- **Load average** — kernel concept that doesn't map cleanly to a single k8s node
- **CPU temperature** — physical sensors aren't exposed per-node
- **GPU metrics** — not collected (would need device-plugin integration)
- **Disk I/O** and **network I/O** rates — would report the underlying VM's view

These appear as `null` in the API and as missing values in the UI, rather than misleading numbers.

## Host group / cluster organization

Set `INSIGHTD_HOST_GROUP` on the DaemonSet to label all nodes in this cluster as belonging to a single group on the Hosts page:

```yaml
- name: INSIGHTD_HOST_GROUP
  value: production-cluster
```

The Hosts page renders one collapsible section per group, with an "Ungrouped" section for hosts that haven't set one. Individual hosts can also be retagged from the host detail page in the UI — the manual override beats the env var.

## Memory total caveat for k3d / unconstrained nodes

The kubelet reports the node's *allocatable* memory, which is whatever the OS thinks is available. **k3d nodes don't set Docker memory limits by default**, so each k3d node reports the entire host machine's RAM as its total — even though k3s only uses a small fraction.

Real production k8s clusters with proper node sizing get correct totals. To fix it for k3d, pass `--servers-memory` / `--agents-memory` at cluster creation:

```bash
k3d cluster create my-cluster --servers-memory 4G --agents-memory 4G
```

## What's not supported in k8s mode

- **Container actions** (start/stop/restart/remove) — these would require
  managing pods/deployments, which is the cluster's job
- **Image update checks** — Kubernetes manages image updates via
  deployments and rollouts; checking digests against Docker Hub is not
  meaningful in this context

If you need to perform actions or check image updates, use the Docker
runtime mode instead.

## RBAC permissions

The DaemonSet uses a ServiceAccount with these cluster permissions:

- `pods` and `pods/log` — get, list, watch (to discover pods on the node and read logs)
- `nodes` — get, list (to verify the node exists, read capacity for total memory, read `creationTimestamp` for uptime)
- `nodes/metrics`, `nodes/stats`, `nodes/proxy` — get (to query the kubelet's `/metrics/cadvisor` and `/stats/summary` endpoints)
- `replicasets` (apps API group) — get, list (to walk pod owner references up to the parent Deployment for stable container names across rollouts)

These are read-only permissions. The agent never modifies anything in the cluster.

## Architecture

```
       ┌──────────────────────┐
       │   Hub (anywhere)     │
       │  + MQTT broker       │
       └──────────┬───────────┘
                  │ MQTT
   ┌──────────────┼──────────────┐
   │              │              │
┌──┴───┐      ┌───┴──┐      ┌────┴─┐
│node 1│      │node 2│      │node 3│
│agent │      │agent │      │agent │
└──────┘      └──────┘      └──────┘
   │              │              │
 pods           pods           pods
```

Each agent only sees pods on its own node (via `spec.nodeName` field
selector). No cross-node coordination is needed.

## Custom kubelet URL

By default the agent talks to `https://${NODE_IP}:10250`. If your kubelet
listens on a different port or you need to override the URL, set
`INSIGHTD_KUBELET_URL` in the DaemonSet env vars.

## Standalone (non-DaemonSet) mode

You can also run the agent outside the cluster pointing at a kubeconfig.
Set `INSIGHTD_RUNTIME=kubernetes` and `NODE_NAME` to the node you want
to monitor. The agent will use the default kubeconfig (`~/.kube/config` or
`KUBECONFIG` env var) to authenticate. This mode is mainly useful for
development and testing — for production, use the DaemonSet.
