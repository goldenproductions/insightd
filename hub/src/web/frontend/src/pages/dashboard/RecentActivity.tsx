import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import type { RecentActivityItem } from '@/types/api';

const TONE_DOT: Record<RecentActivityItem['tone'], string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
  success: 'bg-success',
  info: 'bg-info',
  muted: 'bg-muted',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

function targetHref(item: RecentActivityItem): string | null {
  if (item.type === 'insight' && item.target.includes('/')) {
    const slash = item.target.indexOf('/');
    const hostId = item.target.slice(0, slash);
    const rest = item.target.slice(slash + 1);
    return `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(rest)}`;
  }
  if (item.host_id) return `/hosts/${encodeURIComponent(item.host_id)}`;
  return null;
}

function ActivityRow({ item }: { item: RecentActivityItem }) {
  const href = targetHref(item);
  const inner = (
    <div className="flex items-center gap-3 py-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} aria-hidden="true" />
      <time className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted" title={item.time}>
        {formatTime(item.time)}
      </time>
      <span className="w-28 shrink-0 truncate font-mono text-xs text-secondary">{item.host_id}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.message}</span>
    </div>
  );
  return href ? (
    <Link
      to={href}
      className="-mx-2 block rounded px-2 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
    >
      {inner}
    </Link>
  ) : (
    <div className="px-0">{inner}</div>
  );
}

export function RecentActivity({ items }: { items: RecentActivityItem[] }) {
  return (
    <Card title="Recent activity">
      {items.length === 0 ? (
        <EmptyState message="No fleet activity in the last 24 hours." />
      ) : (
        <div className="divide-y divide-border-light">
          {items.map((item, i) => (
            <ActivityRow key={`${item.time}-${item.target}-${i}`} item={item} />
          ))}
        </div>
      )}
    </Card>
  );
}
