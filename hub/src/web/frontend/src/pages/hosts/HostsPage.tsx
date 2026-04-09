import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { Host, ContainerSnapshot } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';
import { useShowInternal } from '@/hooks/useShowInternal';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { queryKeys } from '@/lib/queryKeys';

const UNGROUPED = 'Ungrouped';
const COLLAPSE_KEY = 'insightd.hostGroupsCollapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(COLLAPSE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>): void {
  try {
    sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(set)));
  } catch { /* ignore */ }
}

export function HostsPage() {
  const navigate = useNavigate();
  const { showInternal } = useShowInternal();
  const { data: hosts } = useQuery({ queryKey: queryKeys.hosts(), queryFn: () => api<Host[]>('/hosts'), refetchInterval: 30_000 });

  const groups = useMemo(() => {
    if (!hosts) return [];
    const byGroup = new Map<string, Host[]>();
    for (const h of hosts) {
      const g = h.host_group && h.host_group.length > 0 ? h.host_group : UNGROUPED;
      const list = byGroup.get(g);
      if (list) list.push(h);
      else byGroup.set(g, [h]);
    }
    // Named groups alphabetically, then "Ungrouped" last.
    return Array.from(byGroup.entries()).sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [hosts]);

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = (name: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveCollapsed(next);
      return next;
    });
  };

  if (!hosts) return <LoadingState />;

  // No hosts have a group set → render the original flat grid (no nesting noise).
  const onlyUngrouped = groups.length === 1 && groups[0]?.[0] === UNGROUPED;

  return (
    <div className="space-y-6">
      <PageTitle>Hosts</PageTitle>
      {hosts.length === 0 ? (
        <EmptyState message="No hosts connected yet" />
      ) : onlyUngrouped ? (
        <HostGrid hosts={hosts} showInternal={showInternal} navigate={navigate} />
      ) : (
        <div className="space-y-4">
          {groups.map(([name, members]) => {
            const isCollapsed = collapsed.has(name);
            return (
              <div key={name} className="rounded-xl border border-border bg-surface">
                <button
                  type="button"
                  onClick={() => toggle(name)}
                  className="flex w-full items-center justify-between p-4 lg:p-5 text-left hover-surface rounded-xl"
                >
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
                    {name} <span className="text-muted normal-case">({members.length})</span>
                  </h2>
                  <span className="text-muted text-xs">{isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="px-4 lg:px-5 pb-4 lg:pb-5">
                    <HostGrid hosts={members} showInternal={showInternal} navigate={navigate} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HostGrid({ hosts, showInternal, navigate }: { hosts: Host[]; showInternal: boolean; navigate: (path: string) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {hosts.map(h => (
        <HostCard key={h.host_id} host={h} showInternal={showInternal} onClick={() => navigate(`/hosts/${encodeURIComponent(h.host_id)}`)} />
      ))}
    </div>
  );
}

function HostCard({ host, onClick, showInternal }: { host: Host; onClick: () => void; showInternal: boolean }) {
  const si = showInternal ? '?showInternal=true' : '';
  const { data: containers } = useQuery({
    queryKey: queryKeys.hostContainers(host.host_id, showInternal),
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(host.host_id)}/containers${si}`),
    refetchInterval: 30_000,
  });

  const running = containers?.filter(c => c.status === 'running').length ?? 0;
  const total = containers?.length ?? 0;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-xl p-4 hover-surface card-interactive bg-surface border border-border"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-semibold text-fg">
          <StatusDot status={host.is_online ? 'online' : 'offline'} size="md" />
          {host.host_id}
        </span>
        <Badge text={host.is_online ? 'online' : 'offline'} color={host.is_online ? 'green' : 'red'} />
      </div>
      <div className="mt-2 text-xs text-muted">
        {running}/{total} containers running<br />
        Last seen {timeAgo(host.last_seen)}
      </div>
    </div>
  );
}
