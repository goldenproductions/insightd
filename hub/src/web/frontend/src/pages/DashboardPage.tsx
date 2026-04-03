import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';
import type { DashboardData, Rankings } from '@/types/api';
import { Card } from '@/components/Card';
import { RankingList } from '@/components/RankingList';
import { HealthBadge } from '@/components/HealthBadge';
import { useShowInternal } from '@/lib/useShowInternal';
import { fmtDurationMs, timeAgo } from '@/lib/formatters';

interface AttentionItem {
  kind: 'alert' | 'downtime' | 'insight';
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  meta: string;
  time: string | null;
  to: string;
}

export function DashboardPage() {
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data } = useQuery({ queryKey: ['dashboard', showInternal], queryFn: () => api<DashboardData>(`/dashboard${si}`) });
  const { data: rankings } = useQuery({ queryKey: ['rankings'], queryFn: () => api<Rankings>('/rankings?limit=5') });

  const attentionItems = useMemo(() => {
    if (!data) return [];
    const items: AttentionItem[] = [];

    for (const alert of data.activeAlertsList) {
      items.push({
        kind: 'alert',
        severity: 'critical',
        title: alert.alert_type.replace(/_/g, ' '),
        detail: alert.target,
        meta: alert.host_id,
        time: alert.triggered_at,
        to: `/hosts/${encodeURIComponent(alert.host_id)}/containers/${encodeURIComponent(alert.target)}`,
      });
    }

    for (const c of data.availability.downContainers) {
      const hasAlert = data.activeAlertsList.some(a => a.host_id === c.hostId && a.target === c.name);
      if (hasAlert) continue;
      items.push({
        kind: 'downtime',
        severity: c.uptimePercent < 95 ? 'critical' : 'warning',
        title: `${c.name} down ~${fmtDurationMs(c.downMinutes * 60000)}`,
        detail: `${c.uptimePercent}% uptime`,
        meta: c.hostId,
        time: null,
        to: `/hosts/${encodeURIComponent(c.hostId)}/containers/${encodeURIComponent(c.name)}`,
      });
    }

    for (const insight of data.topInsights) {
      if (insight.severity === 'info') continue;
      const parts = insight.entity_id.split('/');
      items.push({
        kind: 'insight',
        severity: insight.severity as 'critical' | 'warning',
        title: insight.title,
        detail: insight.message,
        meta: insight.entity_id,
        time: null,
        to: insight.entity_type === 'container' && parts.length === 2
          ? `/hosts/${encodeURIComponent(parts[0]!)}/containers/${encodeURIComponent(parts[1]!)}`
          : `/hosts/${encodeURIComponent(insight.entity_id)}`,
      });
    }

    const sevOrder = { critical: 0, warning: 1 } as const;
    const kindOrder = { alert: 0, downtime: 1, insight: 2 } as const;
    items.sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || (kindOrder[a.kind] - kindOrder[b.kind]));
    return items;
  }, [data]);

  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex items-center justify-center gap-12 py-4">
        {data.systemHealthScore && (
          <div className="flex flex-col items-center gap-1">
            <HealthBadge score={data.systemHealthScore.score} size="lg" />
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>System Health</span>
          </div>
        )}
        <div className="flex flex-col items-center gap-1">
          <span className="text-4xl font-bold" style={{
            color: data.availability.overallPercent == null ? 'var(--text-muted)'
              : data.availability.overallPercent >= 99 ? 'var(--color-success)'
              : data.availability.overallPercent >= 95 ? 'var(--color-warning)'
              : 'var(--color-danger)',
          }}>
            {data.availability.overallPercent != null ? `${data.availability.overallPercent}%` : '-'}
          </span>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Availability (24h)</span>
        </div>
      </div>

      {/* Compact Status Row */}
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-xl px-4 py-3"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
        <StatusItem label="Hosts" value={`${data.hostsOnline}/${data.hostCount}`} to="/hosts"
          color={data.hostsOffline > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <Dot />
        <StatusItem label="Containers" value={`${data.containersRunning}/${data.totalContainers}`} to="/hosts"
          color={data.containersDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <Dot />
        <StatusItem label="Alerts" value={data.activeAlerts} to="/alerts"
          color={data.activeAlerts > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        <Dot />
        <StatusItem label="Disk" value={data.diskWarnings} to="/hosts"
          color={data.diskWarnings > 0 ? 'var(--color-warning)' : 'var(--color-success)'} />
        <Dot />
        <StatusItem label="Updates" value={data.updatesAvailable} to="/updates"
          color={data.updatesAvailable > 0 ? 'var(--color-info)' : undefined} />
        {data.endpointsTotal > 0 && (
          <>
            <Dot />
            <StatusItem label="Endpoints" value={`${data.endpointsUp}/${data.endpointsTotal}`} to="/endpoints"
              color={data.endpointsDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
          </>
        )}
      </div>

      {/* Needs Attention */}
      {attentionItems.length > 0 ? (
        <Card title="Needs Attention">
          <div className="space-y-1">
            {attentionItems.map((item, i) => (
              <Link key={i} to={item.to}
                className="flex items-center gap-3 rounded-lg px-3 py-2 -mx-1 transition-colors"
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{
                  backgroundColor: item.severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)',
                }} />
                <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase" style={{
                  backgroundColor: item.severity === 'critical' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                  color: item.severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)',
                }}>
                  {item.kind}
                </span>
                <span className="flex-1 truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {item.title}
                </span>
                <span className="hidden truncate text-xs sm:block" style={{ color: 'var(--text-secondary)', maxWidth: '12rem' }}>
                  {item.detail}
                </span>
                <span className="flex-shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {item.meta}
                </span>
                {item.time && (
                  <span className="flex-shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {timeAgo(item.time)}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-xl px-4 py-3"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--color-success)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-success)' }}>All systems operational</span>
        </div>
      )}

      {/* Services */}
      {data.groups && data.groups.length > 0 && (
        <Card title="Services">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.groups.map(g => (
              <Link key={g.id} to={`/services/${g.id}`} className="block rounded-lg p-3 transition-colors" style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${g.color || 'var(--color-info)'}` }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                <div className="font-medium text-sm" style={{ color: 'var(--text)' }}>{g.icon && <span className="mr-1">{g.icon}</span>}{g.name}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  <span className={g.running_count === g.member_count ? 'text-emerald-500' : 'text-red-500'}>{g.running_count}/{g.member_count}</span> running
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Rankings */}
      {rankings && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Top CPU">
            <RankingList items={rankings.byCpu} valueKey="cpu_percent" formatFn={v => v.toFixed(1) + '%'} />
          </Card>
          <Card title="Top Memory">
            <RankingList items={rankings.byMemory} valueKey="memory_mb" formatFn={v => Math.round(v) + ' MB'} />
          </Card>
        </div>
      )}
    </div>
  );
}

function StatusItem({ label, value, color, to }: { label: string; value: React.ReactNode; color?: string; to?: string }) {
  const inner = (
    <span className="text-sm">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>{' '}
      <span className="font-semibold" style={{ color: color || 'var(--text)' }}>{value}</span>
    </span>
  );
  if (to) return <Link to={to} className="transition-opacity hover:opacity-80">{inner}</Link>;
  return inner;
}

function Dot() {
  return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>&middot;</span>;
}

function Loading() {
  return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;
}
