export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
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
