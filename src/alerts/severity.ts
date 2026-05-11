export {};

type Severity = 'critical' | 'warning' | 'info';

const DEFAULT_SEVERITY: Record<string, Severity> = {
  host_offline:                'critical',
  container_down:              'critical',
  workload_unavailable:        'critical',
  endpoint_down:               'critical',
  pve_cluster_quorum_lost:     'critical',
  node_not_ready:              'critical',
  pve_zfs_unhealthy:           'critical',
  cert_expired:                'critical',
  disk_full:                   'critical',
  pve_storage_saturation:      'critical',
  image_pull_failure:          'critical',
  restart_loop:                'warning',
  high_cpu:                    'warning',
  high_memory:                 'warning',
  container_memory_saturation: 'warning',
  container_cpu_saturation:    'warning',
  high_host_cpu:               'warning',
  low_host_memory:             'warning',
  high_load:                   'warning',
  container_unhealthy:         'warning',
  node_pressure:               'warning',
  workload_degraded:           'warning',
  workload_rollout_stuck:      'warning',
  pod_pending:                 'warning',
  cert_expiring_soon:          'warning',
  cert_invalid:                'warning',
  pve_backup_overdue:          'warning',
};

const ALERT_DESCRIPTIONS: Record<string, string> = {
  host_offline:                'Agent stopped reporting — host may be down or partitioned.',
  container_down:              'A container that was running is now exited or dead.',
  workload_unavailable:        'Kubernetes workload has zero ready replicas.',
  endpoint_down:               'HTTP endpoint check failed for N consecutive runs.',
  pve_cluster_quorum_lost:     'Proxmox cluster lost quorum — split-brain risk.',
  node_not_ready:              'Kubernetes node Ready condition is not True.',
  pve_zfs_unhealthy:           'Proxmox ZFS pool reports DEGRADED/FAULTED state.',
  cert_expired:                'TLS certificate already expired — site is broken.',
  disk_full:                   'Disk usage above threshold (severity depends on diskCriticalPercent).',
  pve_storage_saturation:      'Proxmox storage above threshold (severity gated like disk_full).',
  image_pull_failure:          'k8s ImagePullBackOff / ErrImagePull / InvalidImageName / CreateContainerConfigError.',
  restart_loop:                'Container restarted N times in the last 30 minutes.',
  high_cpu:                    'Container CPU above threshold percent.',
  high_memory:                 'Container memory MB above threshold.',
  container_memory_saturation: 'Container near its k8s memory limit (OOMKill risk).',
  container_cpu_saturation:    'Container near its k8s CPU limit.',
  high_host_cpu:               'Host CPU above threshold percent.',
  low_host_memory:             'Host available memory below threshold MB.',
  high_load:                   'Host 5-min load average above threshold.',
  container_unhealthy:         'Docker / k8s health check is failing.',
  node_pressure:               'k8s node MemoryPressure / DiskPressure / PIDPressure is True.',
  workload_degraded:           'Workload has some but not all replicas ready past threshold.',
  workload_rollout_stuck:      'Workload has pending updates that are not progressing.',
  pod_pending:                 'Pod stuck Pending past threshold minutes.',
  cert_expiring_soon:          'TLS certificate expires inside warning window.',
  cert_invalid:                'TLS chain or hostname mismatch.',
  pve_backup_overdue:          'Proxmox guest has no successful vzdump in N days.',
};

interface AlertLike { type: string; value?: any }
interface RuleLike { severity: Severity }

function effectiveSeverity(alert: AlertLike, rule: RuleLike, diskCriticalPercent: number): Severity {
  if (alert.type !== 'disk_full' && alert.type !== 'pve_storage_saturation') {
    return rule.severity;
  }
  const pct = Number(alert.value);
  if (!Number.isFinite(pct)) return rule.severity;
  return pct >= diskCriticalPercent ? 'critical' : 'warning';
}

module.exports = { DEFAULT_SEVERITY, ALERT_DESCRIPTIONS, effectiveSeverity };
