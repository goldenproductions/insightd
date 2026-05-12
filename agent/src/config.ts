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

  // Proxmox VE identity bridge — set on the in-guest agent so the hub can
  // link "the VM as the hypervisor sees it" with "the host the VM's own
  // agent reports under". Both must be set together; either alone is a
  // configuration mistake. See docs/proxmox-setup.md.
  // NB: separate from the PVE_API vars below — these are set on the
  // *in-guest* agent pointing back at PVE; the PVE_API vars are set on
  // the agent that's *talking to* PVE (typically a different process).
  proxmoxNode: process.env.INSIGHTD_PROXMOX_NODE || '',
  proxmoxVmid: process.env.INSIGHTD_PROXMOX_VMID || '',

  // Proxmox VE REST API transport — when set, the agent talks to PVE over
  // HTTPS instead of shelling out to local pvesh. Lets the agent run from
  // any guest VM that can reach the PVE web port (default 8006), without
  // installing Node + the agent on the hypervisor itself. Token model is
  // `user@realm!tokenid` + secret; create via Datacenter → Permissions →
  // API Tokens. See docs/proxmox-setup.md for the full walkthrough.
  pveApiUrl: process.env.INSIGHTD_PVE_API_URL || '',
  pveTokenId: process.env.INSIGHTD_PVE_TOKEN_ID || '',
  pveTokenSecret: process.env.INSIGHTD_PVE_TOKEN_SECRET || '',
  pveVerifyTls: process.env.INSIGHTD_PVE_VERIFY_TLS === 'true',
  pveCaBundle: process.env.INSIGHTD_PVE_CA_BUNDLE || '',
  // PVE node this agent is responsible for. Mirrors PR1's "one agent per
  // PVE node" model — in REST mode there's no `local=1` row to autodiscover
  // from, so the operator declares which node this process covers.
  pveNode: process.env.INSIGHTD_PVE_NODE || '',

  // Disk warn threshold (used for logging only on agent side)
  diskWarnPercent: parseInt(process.env.INSIGHTD_DISK_WARN_THRESHOLD || '85', 10),

  // Log tailing
  logLines: parseInt(process.env.INSIGHTD_LOG_LINES || '100', 10),
  logMaxLines: parseInt(process.env.INSIGHTD_LOG_MAX_LINES || '1000', 10),

  // Process collection
  processCollection: {
    enabled: process.env.INSIGHTD_PROCESS_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.INSIGHTD_PROCESS_INTERVAL_MS ?? '5000', 10),
    argvMaxBytes: parseInt(process.env.INSIGHTD_PROCESS_ARGV_MAX ?? '4096', 10),
    dockerTopTimeoutMs: parseInt(process.env.INSIGHTD_PROCESS_DOCKER_TIMEOUT_MS ?? '2000', 10),
  },
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
  // Image updates don't apply to PVE VMs/LXC. Actions DO work as of PR4
  // — gated by INSIGHTD_ALLOW_ACTIONS like Docker.
  const isPve = config.runtime === 'proxmox';
  if (isPve && config.allowUpdates) {
    errors.push('INSIGHTD_ALLOW_UPDATES=true is ignored in Proxmox mode (no image concept for VMs/LXC)');
  }
  // Identity bridge env vars must be paired — having one without the other
  // wouldn't be enough to construct the cross-link label so the hub would
  // silently ignore the half-set value, which is a footgun.
  if ((!!config.proxmoxNode) !== (!!config.proxmoxVmid)) {
    errors.push('INSIGHTD_PROXMOX_NODE and INSIGHTD_PROXMOX_VMID must be set together (or both unset)');
  }
  if (config.proxmoxVmid && !/^\d+$/.test(config.proxmoxVmid)) {
    errors.push(`INSIGHTD_PROXMOX_VMID must be a positive integer, got "${config.proxmoxVmid}"`);
  }

  // PVE REST API mode — when INSIGHTD_PVE_API_URL is set, the token + node
  // env vars become required. Validates here so misconfigurations surface
  // at startup, not on the first failed pveApi call mid-cycle.
  const pveApiActive = !!config.pveApiUrl;
  if (pveApiActive && !isPve) {
    errors.push('INSIGHTD_PVE_API_URL is set but INSIGHTD_RUNTIME is not "proxmox" — REST API mode only applies to the proxmox runtime');
  }
  if (pveApiActive) {
    if (!config.pveTokenId) {
      errors.push('INSIGHTD_PVE_TOKEN_ID is required in PVE REST API mode (format: user@realm!tokenid)');
    } else if (!/^[^@!]+@[^!]+![^=]+$/.test(config.pveTokenId)) {
      errors.push(`INSIGHTD_PVE_TOKEN_ID malformed — expected user@realm!tokenid, got "${config.pveTokenId}"`);
    }
    if (!config.pveTokenSecret) {
      errors.push('INSIGHTD_PVE_TOKEN_SECRET is required in PVE REST API mode');
    } else if (config.pveTokenSecret.length < 16) {
      // PVE tokens are UUID-shaped (36 chars). Anything shorter is almost
      // certainly a copy-paste mistake from a credential prefix.
      errors.push(`INSIGHTD_PVE_TOKEN_SECRET looks too short to be a real PVE token (got ${config.pveTokenSecret.length} chars)`);
    }
    if (!config.pveNode) {
      errors.push('INSIGHTD_PVE_NODE is required in PVE REST API mode (one agent per PVE node — name as PVE knows it, e.g. "proxmox-01")');
    }
    if (!config.pveApiUrl.startsWith('https://')) {
      // Warn only — http:// might be a deliberate test setup against a
      // localhost reverse proxy. Surfacing as an error here would block.
      errors.push(`INSIGHTD_PVE_API_URL should use https:// (got "${config.pveApiUrl}") — PVE's API is HTTPS-only by default`);
    }
  }
  // PVE token vars set without API URL — almost certainly a misconfig.
  if (!pveApiActive && (config.pveTokenId || config.pveTokenSecret)) {
    errors.push('INSIGHTD_PVE_TOKEN_ID/SECRET set but INSIGHTD_PVE_API_URL is empty — REST mode will not activate');
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
