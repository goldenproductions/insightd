import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { DayStatus, DayStatusKind, PublicIncident, PublicStatus } from '@/types/api';
import { formatAlertType, fmtDurationMs, timeAgo } from '@/lib/formatters';

const statusConfig = {
  operational: { label: 'All Systems Operational', colorClass: 'text-success', bgClass: 'bg-success/10', dotClass: 'bg-success' },
  degraded: { label: 'Partial Outage', colorClass: 'text-warning', bgClass: 'bg-warning/10', dotClass: 'bg-warning' },
  outage: { label: 'Major Outage', colorClass: 'text-danger', bgClass: 'bg-danger/10', dotClass: 'bg-danger' },
};

const dayColor: Record<DayStatusKind, string> = {
  operational: 'bg-success',
  degraded: 'bg-warning',
  outage: 'bg-danger',
  no_data: 'bg-border',
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
      <div className="mx-auto max-w-3xl space-y-10 px-4 py-10">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-fg">{data.title}</h1>
          <div className={`mt-5 inline-flex items-center gap-2 rounded-full px-5 py-2 ${config.bgClass}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${config.dotClass}`} />
            <span className={`text-sm font-semibold ${config.colorClass}`}>{config.label}</span>
          </div>
        </div>

        <Legend />

        {/* Stacks */}
        {data.groups && data.groups.length > 0 && (
          <Section title="Stacks">
            {data.groups.map(g => (
              <HistoryRow
                key={`g-${g.id}`}
                name={<>{g.icon && <span className="mr-1.5">{g.icon}</span>}{g.name}</>}
                meta={`${g.running_count}/${g.member_count} running`}
                metaOk={g.running_count === g.member_count}
                history={g.history}
              />
            ))}
          </Section>
        )}

        {/* Hosts */}
        {data.hosts && data.hosts.length > 0 && (
          <Section title="Hosts">
            {data.hosts.map(h => (
              <HistoryRow
                key={`h-${h.host_id}`}
                name={h.host_id}
                meta={h.is_online ? 'online' : 'offline'}
                metaOk={h.is_online}
                history={h.history}
              />
            ))}
          </Section>
        )}

        {/* Endpoints */}
        {data.endpoints && data.endpoints.length > 0 && (
          <Section title="Endpoints">
            {data.endpoints.map(e => (
              <HistoryRow
                key={`e-${e.id}`}
                name={e.name}
                meta={e.uptimePercent24h != null ? `${e.uptimePercent24h}% · 24h` : 'no data'}
                metaOk={e.is_up !== false}
                history={e.history}
              />
            ))}
          </Section>
        )}

        {/* Past incidents */}
        {data.incidents && (
          <Section title="Past incidents" subtitle="Last 30 days">
            <IncidentsList incidents={data.incidents} />
          </Section>
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

function Legend() {
  const items: { kind: DayStatusKind; label: string }[] = [
    { kind: 'operational', label: 'Operational' },
    { kind: 'degraded', label: 'Degraded' },
    { kind: 'outage', label: 'Outage' },
    { kind: 'no_data', label: 'No data' },
  ];
  return (
    <div className="flex items-center justify-center gap-4 text-xs text-muted">
      {items.map(it => (
        <span key={it.kind} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-sm ${dayColor[it.kind]}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h2>
        {subtitle && <span className="text-xs text-muted">{subtitle}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function HistoryRow({ name, meta, metaOk, history }: {
  name: React.ReactNode;
  meta: string;
  metaOk: boolean;
  history: DayStatus[];
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">{name}</span>
        <span className={`text-xs font-medium ${metaOk ? 'text-success' : 'text-danger'}`}>{meta}</span>
      </div>
      <UptimeBar history={history} />
    </div>
  );
}

function UptimeBar({ history }: { history: DayStatus[] }) {
  const withData = history.filter(d => d.uptimePercent != null);
  const avg = withData.length > 0
    ? withData.reduce((s, d) => s + (d.uptimePercent ?? 0), 0) / withData.length
    : null;

  return (
    <div className="mt-3">
      <div className="flex gap-[2px]">
        {history.map(d => (
          <span
            key={d.date}
            title={`${d.date} — ${d.uptimePercent == null ? 'no data' : `${d.uptimePercent}% uptime`}`}
            className={`h-6 flex-1 rounded-[2px] ${dayColor[d.status]}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-muted">
        <span>30 days ago</span>
        <span>{avg != null ? `${avg.toFixed(2)}% uptime` : ''}</span>
        <span>today</span>
      </div>
    </div>
  );
}

function IncidentsList({ incidents }: { incidents: PublicIncident[] }) {
  if (incidents.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
        No incidents reported in the last 30 days.
      </div>
    );
  }

  // Group by local date of resolution.
  const groups = new Map<string, PublicIncident[]>();
  for (const inc of incidents) {
    const dayKey = new Date(inc.resolved_at + 'Z').toISOString().slice(0, 10);
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey)!.push(inc);
  }

  return (
    <div className="space-y-4">
      {Array.from(groups.entries()).map(([day, items]) => (
        <div key={day}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">
            {formatIncidentDay(day)}
          </div>
          <div className="space-y-2">
            {items.map(inc => (
              <div key={inc.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg">
                      {formatAlertType(inc.alert_type)}
                      <span className="ml-2 text-xs font-normal text-muted">{inc.target}</span>
                    </div>
                    {inc.message && (
                      <div className="mt-1 truncate text-xs text-secondary">{inc.message}</div>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted">
                    <div>Resolved {timeAgo(inc.resolved_at)}</div>
                    <div className="mt-0.5">Duration {fmtDurationMs(inc.durationMinutes * 60000)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatIncidentDay(dayKey: string): string {
  const d = new Date(dayKey + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return dayKey;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      {children}
    </div>
  );
}
