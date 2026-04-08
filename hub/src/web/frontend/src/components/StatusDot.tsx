import { memo } from 'react';

const colors: Record<string, string> = {
  online: 'bg-success',
  running: 'bg-success',
  up: 'bg-success',
  green: 'bg-success',
  offline: 'bg-danger',
  exited: 'bg-danger',
  dead: 'bg-danger',
  down: 'bg-danger',
  red: 'bg-danger',
  yellow: 'bg-amber-500',
  unhealthy: 'bg-amber-500',
  none: 'bg-gray-400',
};

const liveStatuses = new Set(['online', 'running', 'up', 'green']);

export const StatusDot = memo(function StatusDot({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'h-3 w-3' : size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const colorClass = colors[status] || 'bg-gray-400';
  const pulseClass = liveStatuses.has(status) ? 'status-dot-live' : '';
  return <span role="img" aria-label={`Status: ${status}`} className={`inline-block rounded-full ${sizeClass} ${colorClass} ${pulseClass}`} />;
});
