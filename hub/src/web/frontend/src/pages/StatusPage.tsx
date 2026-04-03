import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PublicStatus } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

const statusConfig = {
  operational: { label: 'All Systems Operational', color: 'var(--color-success)', bg: 'rgba(16,185,129,0.1)' },
  degraded: { label: 'Partial Outage', color: 'var(--color-warning)', bg: 'rgba(245,158,11,0.1)' },
  outage: { label: 'Major Outage', color: 'var(--color-danger)', bg: 'rgba(239,68,68,0.1)' },
};

export function StatusPage() {
  const { data, error } = useQuery({
    queryKey: ['public-status'],
    queryFn: () => api<PublicStatus>('/status'),
    refetchInterval: 60000,
  });

  if (error) {
    return (
      <PageShell>
        <div className="py-20 text-center">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>Status Page</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Status page is not available.</p>
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell>
        <div className="py-20 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>
      </PageShell>
    );
  }

  const config = statusConfig[data.overallStatus];

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>{data.title}</h1>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2" style={{ backgroundColor: config.bg }}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: config.color }} />
            <span className="text-sm font-semibold" style={{ color: config.color }}>{config.label}</span>
          </div>
        </div>

        {/* Services */}
        {data.groups.length > 0 && (
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Services</h2>
            <div className="space-y-3">
              {data.groups.map(g => (
                <div key={g.id} className="rounded-xl p-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                      {g.icon && <span className="mr-1">{g.icon}</span>}{g.name}
                    </span>
                    <span className="text-xs font-medium" style={{
                      color: g.running_count === g.member_count ? 'var(--color-success)' : 'var(--color-danger)',
                    }}>
                      {g.running_count}/{g.member_count} running
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {g.members.map(m => (
                      <div key={`${m.host_id}/${m.container_name}`} className="flex items-center gap-2 text-xs">
                        <span className="h-1.5 w-1.5 rounded-full" style={{
                          backgroundColor: m.status === 'running' ? 'var(--color-success)' : 'var(--color-danger)',
                        }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{m.container_name}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{m.status || 'unknown'}</span>
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
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Endpoints</h2>
            <div className="space-y-3">
              {data.endpoints.map(e => (
                <div key={e.name} className="rounded-xl p-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{
                        backgroundColor: e.is_up === true ? 'var(--color-success)' : e.is_up === false ? 'var(--color-danger)' : 'var(--text-muted)',
                      }} />
                      <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{e.name}</span>
                    </div>
                    {e.uptimePercent24h != null && (
                      <span className="text-sm font-bold" style={{
                        color: e.uptimePercent24h >= 99 ? 'var(--color-success)' : e.uptimePercent24h >= 95 ? 'var(--color-warning)' : 'var(--color-danger)',
                      }}>
                        {e.uptimePercent24h}%
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {e.avgResponseMs != null && <span>avg {Math.round(e.avgResponseMs)}ms</span>}
                    {e.lastCheckedAt && <span>checked {timeAgo(e.lastCheckedAt)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          <p>Updated {timeAgo(data.updatedAt)}</p>
          <p className="mt-1">Powered by insightd</p>
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
      {children}
    </div>
  );
}
