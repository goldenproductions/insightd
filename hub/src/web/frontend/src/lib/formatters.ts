export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'never';
  // Two timestamp shapes show up in API payloads:
  //   1. SQLite datetime('now'):       "2026-04-13 19:14:06"  (no tz — UTC implicit)
  //   2. JavaScript Date#toISOString:  "2026-04-13T19:14:06.000Z" (already UTC)
  // Treat anything with a T or Z as already-parsed-correctly; only the plain
  // SQLite shape needs the explicit `Z` appended to force UTC interpretation.
  const normalized = /[TZ]/.test(dateStr) ? dateStr : dateStr + 'Z';
  const t = new Date(normalized).getTime();
  if (Number.isNaN(t)) return 'never';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function fmtPercent(value: number | null | undefined): string {
  if (value == null) return '-';
  return value.toFixed(1) + '%';
}

export function fmtMs(value: number | null | undefined): string {
  if (value == null) return '-';
  return value + 'ms';
}

export function fmtMb(value: number | null | undefined): string {
  if (value == null) return '-';
  return Math.round(value) + ' MB';
}

export function fmtBytesPerSec(value: number | null | undefined): string {
  if (value == null) return '-';
  if (value < 1024) return value + ' B/s';
  if (value < 1048576) return (value / 1024).toFixed(1) + ' KB/s';
  if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB/s';
  return (value / 1073741824).toFixed(2) + ' GB/s';
}

export function fmtCelsius(value: number | null | undefined): string {
  if (value == null) return '-';
  return value.toFixed(1) + '\u00B0C';
}

export function fmtDurationMs(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  container_down: 'Container stopped',
  container_unhealthy: 'Container unhealthy',
  restart_loop: 'Restart loop',
  high_cpu: 'Container CPU high',
  high_memory: 'Container memory high',
  disk_full: 'Disk almost full',
  high_host_cpu: 'Host CPU high',
  low_host_memory: 'Host memory low',
  high_load: 'Host load high',
  endpoint_down: 'Endpoint down',
};

/** Map a backend alert_type to a friendlier display label. Falls back to the
 * underscored-to-spaced raw value for unknown types so new alert kinds still
 * render readably. */
export function formatAlertType(type: string): string {
  return ALERT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}
