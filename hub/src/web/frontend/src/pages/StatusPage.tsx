import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { PublicStatus } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

const statusConfig = {
  operational: { label: 'All Systems Operational', colorClass: 'text-success', bgClass: 'bg-success/10', dotClass: 'bg-success' },
  degraded: { label: 'Partial Outage', colorClass: 'text-warning', bgClass: 'bg-warning/10', dotClass: 'bg-warning' },
  outage: { label: 'Major Outage', colorClass: 'text-danger', bgClass: 'bg-danger/10', dotClass: 'bg-danger' },
};

export function StatusPage() {
  const { data, error } = useQuery({
    queryKey: queryKeys.publicStatus(),
    queryFn: () => api<PublicStatus>('/status'),
    refetchInterval: 60000,
  });

  if (error) {
    return (
      <PageShell>
        <div className="py-20 text-center">
          <h1 className="text-2xl font-bold text-fg">Status Page</h1>
          <p className="mt-2 text-sm text-muted">Status page is not available.</p>
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell>
        <div className="py-20 text-center text-sm text-muted">Loading...</div>
      </PageShell>
    );
  }

  const config = statusConfig[data.overallStatus];

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-fg">{data.title}</h1>
          <div className={`mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 ${config.bgClass}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${config.dotClass}`} />
            <span className={`text-sm font-semibold ${config.colorClass}`}>{config.label}</span>
          </div>
        </div>

        {/* Stacks */}
        {data.groups.length > 0 && (
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary">Stacks</h2>
            <div className="space-y-3">
              {data.groups.map(g => (
                <div key={g.id} className="rounded-xl p-4 bg-surface border border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-fg">
                      {g.icon && <span className="mr-1">{g.icon}</span>}{g.name}
                    </span>
                    <span className={`text-xs font-medium ${g.running_count === g.member_count ? 'text-success' : 'text-danger'}`}>
                      {g.running_count}/{g.member_count} running
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {g.members.map(m => (
                      <div key={`${m.host_id}/${m.container_name}`} className="flex items-center gap-2 text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${m.status === 'running' ? 'bg-success' : 'bg-danger'}`} />
                        <span className="text-secondary">{m.container_name}</span>
                        <span className="text-muted">{m.status || 'unknown'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Endpoints */}
        {data.endpoints.length > 0 && (
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary">Endpoints</h2>
            <div className="space-y-3">
              {data.endpoints.map(e => (
                <div key={e.name} className="rounded-xl p-4 bg-surface border border-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${e.is_up === true ? 'bg-success' : e.is_up === false ? 'bg-danger' : 'bg-(--text-muted)'}`} />
                      <span className="text-sm font-semibold text-fg">{e.name}</span>
                    </div>
                    {e.uptimePercent24h != null && (
                      <span className={`text-sm font-bold ${e.uptimePercent24h >= 99 ? 'text-success' : e.uptimePercent24h >= 95 ? 'text-warning' : 'text-danger'}`}>
                        {e.uptimePercent24h}%
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-3 text-xs text-muted">
                    {e.avgResponseMs != null && <span>avg {Math.round(e.avgResponseMs)}ms</span>}
                    {e.lastCheckedAt && <span>checked {timeAgo(e.lastCheckedAt)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-muted">
          <p>Updated {timeAgo(data.updatedAt)}</p>
          <p className="mt-1">Powered by insightd</p>
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      {children}
    </div>
  );
}
