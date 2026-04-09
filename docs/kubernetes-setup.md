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
- **Container names** use the format `{namespace}/{pod-name}/{container-name}`
- **CPU/memory metrics** from the kubelet's cAdvisor endpoint
- **Restart count** directly from the pod status
- **Logs** via the Kubernetes API

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
- `nodes` — get, list (to verify the node exists at startup)
- `nodes/metrics`, `nodes/stats`, `nodes/proxy` — get (to query the kubelet's cAdvisor endpoint)

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
