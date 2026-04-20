import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Card } from '@/components/Card';
import { LinkButton } from '@/components/FormField';
import { StatusDot } from '@/components/StatusDot';
import { EmptyState } from '@/components/EmptyState';
import { timeAgo } from '@/lib/formatters';
import type { Host } from '@/types/api';

const UNGROUPED_LABEL = 'Ungrouped';

function effectiveGroup(h: Host): string | null {
  const override = h.host_group_override;
  if (override === '') return null; // manually ungrouped
  if (override && override.length > 0) return override;
  if (h.host_group && h.host_group.length > 0) return h.host_group;
  return null;
}

export function DashboardHosts() {
  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<Host[]>('/hosts'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const grouped = useMemo(() => {
    if (!hosts) return [];
    const byGroup = new Map<string, Host[]>();
    for (const h of hosts) {
      const g = effectiveGroup(h) ?? UNGROUPED_LABEL;
      const list = byGroup.get(g);
      if (list) list.push(h);
      else byGroup.set(g, [h]);
    }
    // Named groups alphabetical, Ungrouped last
    return Array.from(byGroup.entries()).sort(([a], [b]) => {
      if (a === UNGROUPED_LABEL) return 1;
      if (b === UNGROUPED_LABEL) return -1;
      return a.localeCompare(b);
    });
  }, [hosts]);

  return (
    <Card
      title="Hosts"
      actions={<LinkButton to="/hosts" variant="ghost" size="sm">Manage</LinkButton>}
    >
      {!hosts || hosts.length === 0 ? (
        <EmptyState message="No hosts connected yet." />
      ) : (
        <div className="space-y-3">
          {grouped.map(([groupName, members]) => (
            <section key={groupName}>
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {groupName}
                </h3>
                <span className="text-[11px] tabular-nums text-muted">{members.length}</span>
              </div>
              <ul className="divide-y divide-border-light rounded-lg border border-border bg-bg-secondary">
                {members.map(host => (
                  <li key={host.host_id}>
                    <Link
                      to={`/hosts/${encodeURIComponent(host.host_id)}`}
                      className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
                    >
                      <StatusDot status={host.is_online ? 'online' : 'offline'} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
                        {host.host_id}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted">
                        {host.is_online ? 'online' : `seen ${timeAgo(host.last_seen)}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
