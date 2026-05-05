const VERSION = process.env.INSIGHTD_VERSION || '0.3.0';

const config = Object.freeze({
  // Host identification (required). In k8s DaemonSet mode, falls back to NODE_NAME.
  hostId: process.env.INSIGHTD_HOST_ID || process.env.NODE_NAME || 'local',

  // Optional logical group for organizing hosts (e.g. "production", "k3d-test", "basement").
  // Surfaces in the UI as a collapsible section on the Hosts page. Empty string = ungrouped.
  hostGroup: process.env.INSIGHTD_HOST_GROUP || '',

  // MQTT broker
  mqttUrl: process.env.INSIGHTD_MQTT_URL || '',
  mqttUser: process.env.INSIGHTD_MQTT_USER || '',
  mqttPass: process.env.INSIGHTD_MQTT_PASS || '',

  // Container runtime — 'auto' detects Docker/containerd/k8s/Proxmox; can be forced to one
  runtime: (process.env.INSIGHTD_RUNTIME || 'auto') as 'auto' | 'docker' | 'containerd' | 'kubernetes' | 'proxmox',

  // Kubernetes (DaemonSet mode) — set via downward API in the pod spec
  nodeName: process.env.NODE_NAME || '',
  nodeIp: process.env.NODE_IP || '',
  podName: process.env.POD_NAME || '',
  podNamespace: process.env.POD_NAMESPACE || '',

  // Optional kubelet URL override. Defaults to https://${NODE_IP}:10250.
  // Useful for k3s/flatcar or clusters where the kubelet listens on a non-standard port.
  kubeletUrl: process.env.INSIGHTD_KUBELET_URL || '',

  // Docker
  dockerSocket: process.env.DOCKER_HOST || '/var/run/docker.sock',

  // Host filesystem
  hostRoot: process.env.INSIGHTD_HOST_ROOT || '/host',

  // Collection interval
  collectIntervalMinutes: parseInt(process.env.INSIGHTD_COLLECT_INTERVAL || '5', 10),

  // Update check schedule
  updateCheckCron: process.env.INSIGHTD_UPDATE_CHECK_CRON || '0 3 * * *',

  // Timezone
  timezone: process.env.TZ || 'UTC',

  // Updates
  allowUpdates: process.env.INSIGHTD_ALLOW_UPDATES === 'true',

  // Container actions (start/stop/restart)
  allowActions: process.env.INSIGHTD_ALLOW_ACTIONS === 'true',

  // Disk warn threshold (used for logging only on agent side)
  diskWarnPercent: parseInt(process.env.INSIGHTD_DISK_WARN_THRESHOLD || '85', 10),

  // Log tailing
  logLines: parseInt(process.env.INSIGHTD_LOG_LINES || '100', 10),
  logMaxLines: parseInt(process.env.INSIGHTD_LOG_MAX_LINES || '1000', 10),
});

function validate(): string[] {
  const errors: string[] = [];
  if (!config.mqttUrl) errors.push('INSIGHTD_MQTT_URL is required');
  if (!config.hostId || config.hostId === 'local') {
    errors.push('INSIGHTD_HOST_ID should be set to identify this host (e.g., "proxmox-01")');
  }
  // In Kubernetes mode, remote updates and container actions are not supported:
  // pod lifecycle and image updates are managed by the cluster control plane.
  // Warn the operator if they've turned these on so the intent is visible.
  const isK8s = config.runtime === 'kubernetes'
    || (config.runtime === 'auto' && !!process.env.KUBERNETES_SERVICE_HOST);
  if (isK8s && config.allowUpdates) {
    errors.push('INSIGHTD_ALLOW_UPDATES=true is ignored in Kubernetes mode (agent updates are managed by the cluster)');
  }
  if (isK8s && config.allowActions) {
    errors.push('INSIGHTD_ALLOW_ACTIONS=true is ignored in Kubernetes mode (pod lifecycle is managed by the cluster)');
  }
  // Same shape for Proxmox: image updates don't apply to VMs/LXC, and
  // start/stop will land in a later PR. Surface intent now so the operator
  // doesn't think actions silently work.
  const isPve = config.runtime === 'proxmox';
  if (isPve && config.allowUpdates) {
    errors.push('INSIGHTD_ALLOW_UPDATES=true is ignored in Proxmox mode (no image concept for VMs/LXC)');
  }
  if (isK8s && !config.podNamespace) {
    errors.push('POD_NAMESPACE is not set — leader election is disabled, PV/PVC inventory will not be published. Set via downward API (fieldRef metadata.namespace).');
  }
  if (isK8s && !config.podName) {
    errors.push('POD_NAME is not set — leader election needs a unique identity per pod. Set via downward API (fieldRef metadata.name).');
  }
  if (isK8s && !config.hostGroup) {
    errors.push('INSIGHTD_HOST_GROUP is empty — PV/PVC data will use a synthetic cluster id. Set a unique value per cluster to enable proper cross-cluster separation.');
  }
  return errors;
}

module.exports = { config, validate, VERSION };
