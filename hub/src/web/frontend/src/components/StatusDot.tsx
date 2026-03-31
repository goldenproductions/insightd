const colors: Record<string, string> = {
  online: 'bg-emerald-500',
  running: 'bg-emerald-500',
  up: 'bg-emerald-500',
  green: 'bg-emerald-500',
  offline: 'bg-red-500',
  exited: 'bg-red-500',
  dead: 'bg-red-500',
  down: 'bg-red-500',
  red: 'bg-red-500',
  yellow: 'bg-amber-500',
  unhealthy: 'bg-amber-500',
  none: 'bg-gray-400',
};

export function StatusDot({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'h-3 w-3' : size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const colorClass = colors[status] || 'bg-gray-400';
  return <span className={`inline-block rounded-full ${sizeClass} ${colorClass}`} />;
}
