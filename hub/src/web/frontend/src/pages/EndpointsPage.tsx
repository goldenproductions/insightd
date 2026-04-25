import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { DiscoveredIngress, EndpointSummary } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';

type EndpointStatus = 'up' | 'down' | 'degraded' | 'unknown';

/**
 * Resolve an endpoint's display status. "Degraded" is up but slow — a 2s
 * last-response threshold is a homelab-reasonable line for "something's
 * wrong even though the check technically passed".
 */
function statusOf(ep: EndpointSummary): EndpointStatus {
  if (!ep.lastCheck) return 'unknown';
  if (!ep.lastCheck.is_up) return 'down';
  const rt = ep.lastCheck.response_time_ms;
  if (rt != null && rt > 2000) return 'degraded';
  return 'up';
}

const STATUS_PILL: Record<EndpointStatus, { label: string; color: 'green' | 'red' | 'yellow' | 'gray' }> = {
  up:        { label: 'Up',        color: 'green' },
  down:      { label: 'Down',      color: 'red' },
  degraded:  { label: 'Degraded',  color: 'yellow' },
  unknown:   { label: 'No data',   color: 'gray' },
};

function MethodChip({ method }: { method: string }) {
  const isTcp = method.toUpperCase() === 'TCP';
  const cls = isTcp
    ? 'bg-info/10 text-info'
    : 'bg-bg-secondary text-secondary';
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${cls}`}>
      {method}
    </span>
  );
}

/** Tiny per-row sparkline — 30 bars, one per recent check. */
function Sparkline({ checks }: { checks: EndpointSummary['recentChecks'] }) {
  if (!checks || checks.length === 0) {
    return <div className="h-5 w-[120px] text-[10px] text-muted">no data</div>;
  }
  return (
    <div className="flex h-5 items-end gap-[1.5px]" aria-label="recent check history">
      {checks.map((c, i) => {
        const isUp = c.is_up === 1;
        const slow = isUp && c.response_time_ms != null && c.response_time_ms > 2000;
        const color = !isUp ? 'bg-danger' : slow ? 'bg-warning' : 'bg-success';
        const height = !isUp ? '100%' : slow ? '80%' : '55%';
        return <span key={i} className={`w-[3px] rounded-[1px] ${color}`} style={{ height }} />;
      })}
    </div>
  );
}

// Filter tabs — All / Up / Degraded / Down — mirror the design.
type Filter = 'all' | 'up' | 'degraded' | 'down';

function FilterTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${active ? 'bg-fg text-bg' : 'text-secondary hover:bg-surface-hover'}`}
    >
      {label} <span className={`ml-1 tabular-nums ${active ? 'opacity-60' : 'text-muted'}`}>{count}</span>
    </button>
  );
}

export function EndpointsPage() {
  const { isAuthenticated } = useAuth();
  const { data: endpoints } = useQuery({
    queryKey: queryKeys.endpoints(),
    queryFn: () => api<EndpointSummary[]>('/endpoints'),
    refetchInterval: 30_000,
  });
  const { data: discovered } = useQuery({
    queryKey: queryKeys.ingresses(),
    queryFn: () => api<DiscoveredIngress[]>('/ingresses'),
    refetchInterval: 60_000,
  });

  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c = { all: 0, up: 0, degraded: 0, down: 0 };
    for (const ep of endpoints ?? []) {
      c.all++;
      const s = statusOf(ep);
      if (s === 'up') c.up++;
      else if (s === 'degraded') c.degraded++;
      else if (s === 'down') c.down++;
    }
    return c;
  }, [endpoints]);

  const visible = useMemo(() => {
    const list = endpoints ?? [];
    if (filter === 'all') return list;
    return list.filter(ep => statusOf(ep) === filter);
  }, [endpoints, filter]);

  return (
    <div className="space-y-6">
      <PageTitle
        actions={isAuthenticated ? (
          <LinkButton to="/endpoints/new" variant="primary" size="sm">+ New check</LinkButton>
        ) : undefined}
      >
        Endpoints
      </PageTitle>

      {discovered && discovered.length > 0 && (
        <DiscoveredIngressesCard ingresses={discovered} />
      )}

      {!endpoints ? (
        <LoadingState />
      ) : endpoints.length === 0 ? (
        <EmptyState message={isAuthenticated ? 'No endpoints configured. Add one above.' : 'No endpoints configured.'} />
      ) : (
        <Card
          title="Monitored endpoints"
          actions={
            <div className="flex items-center gap-1">
              <FilterTab active={filter === 'all'}      label="All"      count={counts.all}      onClick={() => setFilter('all')} />
              <FilterTab active={filter === 'up'}       label="Up"       count={counts.up}       onClick={() => setFilter('up')} />
              <FilterTab active={filter === 'degraded'} label="Degraded" count={counts.degraded} onClick={() => setFilter('degraded')} />
              <FilterTab active={filter === 'down'}     label="Down"     count={counts.down}     onClick={() => setFilter('down')} />
            </div>
          }
        >
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No endpoints in this filter.</p>
          ) : (
            <ul className="divide-y divide-border-light">
              {visible.map(ep => <EndpointRow key={ep.id} endpoint={ep} />)}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function EndpointRow({ endpoint: ep }: { endpoint: EndpointSummary }) {
  const status = statusOf(ep);
  const pill = STATUS_PILL[status];
  const dotStatus = status === 'up' ? 'up' : status === 'down' ? 'down' : status === 'degraded' ? 'yellow' : 'none';

  return (
    <li>
      <Link
        to={`/endpoints/${ep.id}`}
        className="grid grid-cols-[auto_1fr_120px_90px_90px] items-center gap-4 px-3 py-3 transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
      >
        <StatusDot status={dotStatus} size="md" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{ep.name}</span>
            <Badge text={pill.label} color={pill.color} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-xs text-muted">
            <MethodChip method={ep.method} />
            <span className="truncate">{ep.url}</span>
          </div>
        </div>
        <Sparkline checks={ep.recentChecks} />
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-fg">{ep.avgResponseMs != null ? `${ep.avgResponseMs}ms` : '—'}</div>
          <div className="text-[11px] text-muted">avg 24h</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-fg">{ep.uptimePercent24h != null ? `${ep.uptimePercent24h}%` : '—'}</div>
          <div className="text-[11px] text-muted">uptime</div>
        </div>
      </Link>
    </li>
  );
}

function DiscoveredIngressesCard({ ingresses }: { ingresses: DiscoveredIngress[] }) {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const monitor = useMutation({
    mutationFn: (ingressId: number) =>
      apiAuth<{ id: number | string; url: string; name: string }>(
        'POST', `/endpoints/from-ingress/${ingressId}`, {}, token,
      ),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoints() });
      queryClient.invalidateQueries({ queryKey: queryKeys.ingresses() });
      navigate(`/endpoints/${created.id}`);
    },
  });

  return (
    <Card title="Discovered ingresses">
      <p className="mb-3 text-xs text-muted">Kubernetes ingresses surfaced by your cluster — promote any to a monitored endpoint.</p>
      <ul className="divide-y divide-border-light">
        {ingresses.map(ing => {
          const monitored = ing.monitoredEndpointId != null;
          const primary = ing.hosts[0] ?? ing.name;
          return (
            <li
              key={ing.id}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge text={ing.namespace} color="gray" />
                  <span className="truncate text-sm font-semibold text-fg">{primary}</span>
                  {ing.tlsHosts.includes(primary) && <Badge text="tls" color="green" />}
                  {ing.ingressClass && <span className="font-mono text-[10px] text-muted">{ing.ingressClass}</span>}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted">{ing.defaultUrl}</div>
              </div>
              <div className="justify-self-end">
                {monitored ? (
                  <Link
                    to={`/endpoints/${ing.monitoredEndpointId}`}
                    className="rounded border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success hover:bg-success/15"
                  >
                    monitored
                  </Link>
                ) : isAuthenticated ? (
                  <button
                    type="button"
                    disabled={monitor.isPending && monitor.variables === ing.id}
                    onClick={() => monitor.mutate(ing.id)}
                    className="rounded border border-info/30 bg-info/10 px-2 py-1 text-xs font-medium text-info hover:bg-info/15 disabled:opacity-50"
                  >
                    {monitor.isPending && monitor.variables === ing.id ? '…' : 'monitor'}
                  </button>
                ) : (
                  <span className="text-xs text-muted">log in to monitor</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
