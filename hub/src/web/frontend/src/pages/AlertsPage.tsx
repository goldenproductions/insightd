import { useMemo, useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/hooks/useConfirm';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Card } from '@/components/Card';
import { Button } from '@/components/FormField';
import { PageTitle } from '@/components/PageTitle';
import { SearchIcon } from '@/components/Icons';
import { LoadingState } from '@/components/LoadingState';
import { formatAlertType, fmtDurationMs } from '@/lib/formatters';
import { getContainerNamespace, getContainerDisplayName } from '@/lib/containers';
import type { Alert, AlertLevel, AlertsExploreResponse } from '@/types/api';

const PAGE_SIZE = 20;
const UNTIL_RESOLVED_SENTINEL = '9999-12-31 23:59:59';

interface LevelStyle { bg: string; text: string; glyph: string; glyphClass: string; label: string }

const LEVEL_STYLES: Record<AlertLevel, LevelStyle> = {
  critical: { bg: 'bg-danger/10', text: 'text-danger',  glyph: '▲', glyphClass: 'text-danger',  label: 'Critical' },
  error:    { bg: 'bg-danger/10', text: 'text-danger',  glyph: '◆', glyphClass: 'text-danger',  label: 'Error' },
  warning:  { bg: 'bg-warning/10', text: 'text-warning', glyph: '●', glyphClass: 'text-warning', label: 'Warning' },
  info:     { bg: 'bg-info/10',    text: 'text-info',    glyph: 'ℹ', glyphClass: 'text-info',    label: 'Info' },
};

function LevelPill({ level }: { level: AlertLevel }) {
  const s = LEVEL_STYLES[level];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border border-transparent px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}>
      <span className={`${s.glyphClass} text-[10px] leading-none`}>{s.glyph}</span>
      {s.label}
    </span>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-block rounded border border-danger/20 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">Active</span>
  ) : (
    <span className="inline-block rounded border border-success/20 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Resolved</span>
  );
}

function DurationBar({ durationSec, max }: { durationSec: number; max: number }) {
  const pct = Math.min(1, Math.max(0.02, durationSec / Math.max(max, 1)));
  return (
    <div className="relative h-2 w-[72px]">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted" style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

function formatDT(iso: string): string {
  // Backend returns "YYYY-MM-DD HH:MM:SS" in UTC. Show local MM/DD HH:MM.
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function alertDetailHref(a: Alert): string {
  // Host-scoped alerts: target is descriptive (a metric, a condition type),
  // not a clickable resource. Land on the host page itself.
  const hostScoped = new Set([
    'disk_full', 'high_host_cpu', 'low_host_memory', 'high_load', 'host_offline',
    'node_pressure', 'node_not_ready',
  ]);
  if (hostScoped.has(a.alert_type)) return `/hosts/${encodeURIComponent(a.host_id)}`;
  // Endpoint + cert alerts live on the Endpoints page (host_id="hub" — not
  // a real host, target is the endpoint name).
  if (a.alert_type === 'endpoint_down'
      || a.alert_type === 'cert_expired'
      || a.alert_type === 'cert_expiring_soon'
      || a.alert_type === 'cert_invalid') {
    return '/endpoints';
  }
  // Cluster-scoped alerts have host_id=cluster_id (no host page) and target
  // can contain slashes (e.g. "namespace/pod_name"). No detail page exists,
  // so filter the Alerts page itself by the target — keeps the click useful.
  if (a.alert_type === 'pod_pending') {
    return `/alerts?q=${encodeURIComponent(a.target)}`;
  }
  // Workload-scoped alerts: target is "Kind/namespace/name" — drop the user
  // on the namespace topology page where the workload card is tinted by the
  // active alert. ?focus= can be picked up by the topology to highlight the
  // node; topology already supports ?q= as a fallback search filter.
  if (a.alert_type === 'workload_unavailable'
      || a.alert_type === 'workload_degraded'
      || a.alert_type === 'workload_rollout_stuck') {
    const parts = a.target.split('/');
    if (parts.length === 3 && parts[1] && parts[2]) {
      return `/clusters/${encodeURIComponent(a.host_id)}/namespaces/${encodeURIComponent(parts[1])}/topology?q=${encodeURIComponent(parts[2])}`;
    }
    return `/alerts?q=${encodeURIComponent(a.target)}`;
  }
  return `/hosts/${encodeURIComponent(a.host_id)}/containers/${encodeURIComponent(a.target)}`;
}

function durationOf(a: Alert): number {
  const start = Date.parse(a.triggered_at.replace(' ', 'T') + 'Z');
  const end = a.resolved_at ? Date.parse(a.resolved_at.replace(' ', 'T') + 'Z') : Date.now();
  if (!isFinite(start) || !isFinite(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

// ───────────────────────── URL-synced filter state ─────────────────────────

interface Filters {
  q: string;
  status: 'active' | 'resolved' | null;
  levels: AlertLevel[];
  hosts: string[];
  namespaces: string[];
  muted: boolean | null;
  offset: number;
}

export function readFilters(params: URLSearchParams): Filters {
  const status = params.get('status');
  const muted = params.get('muted');
  const levels = (params.get('levels') ?? '').split(',').filter(Boolean) as AlertLevel[];
  const hosts = (params.get('hosts') ?? '').split(',').filter(Boolean);
  const namespaces = (params.get('namespaces') ?? '').split(',').filter(Boolean);
  return {
    q: params.get('q') ?? '',
    status: status === 'active' || status === 'resolved' ? status : null,
    levels: levels.filter(l => l === 'critical' || l === 'error' || l === 'warning' || l === 'info'),
    hosts,
    namespaces,
    muted: muted === 'true' ? true : muted === 'false' ? false : null,
    offset: Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0),
  };
}

export function writeFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status) p.set('status', f.status);
  if (f.levels.length > 0) p.set('levels', f.levels.join(','));
  if (f.hosts.length > 0) p.set('hosts', f.hosts.join(','));
  if (f.namespaces.length > 0) p.set('namespaces', f.namespaces.join(','));
  if (f.muted != null) p.set('muted', String(f.muted));
  if (f.offset > 0) p.set('offset', String(f.offset));
  return p;
}

// ───────────────────────── Page ─────────────────────────

export function AlertsPage() {
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const { confirm, dialogProps } = useConfirm();

  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    const current = readFilters(searchParams);
    // Any filter change except `offset` itself should also reset pagination.
    const resetOffset = Object.keys(patch).some(k => k !== 'offset');
    const next: Filters = { ...current, ...patch, offset: resetOffset ? 0 : (patch.offset ?? current.offset) };
    setSearchParams(writeFilters(next), { replace: true });
  }, [searchParams, setSearchParams]);

  const queryString = useMemo(() => {
    const p = writeFilters(filters);
    p.set('limit', String(PAGE_SIZE));
    return p.toString();
  }, [filters]);

  const { data, isFetching, refetch } = useQuery({
    queryKey: [...queryKeys.alerts(), queryString] as const,
    queryFn: () => api<AlertsExploreResponse>(`/alerts?${queryString}`),
    refetchInterval: 30_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev, // keep showing previous page while paginating
  });

  useKeyboardShortcut({
    keys: 'r',
    description: 'Refresh alerts',
    scope: 'Alerts',
    onTrigger: () => { refetch(); },
  });

  // ─────── Selection ───────

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  // Clear stale selection whenever the displayed page changes (pagination or filter change).
  useEffect(() => setSelected(new Set()), [queryString]);

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllOnPage = () => {
    const pageIds = (data?.alerts ?? []).map(a => a.id);
    const allSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id));
    setSelected(new Set(allSelected ? [] : pageIds));
  };

  // ─────── Bulk mutations ───────

  const runAll = async (ids: number[], path: (id: number) => string, method: 'POST' | 'DELETE', body?: unknown) => {
    if (ids.length === 0) return;
    await Promise.allSettled(ids.map(id => apiAuth(method, path(id), body, token)));
    await queryClient.invalidateQueries({ queryKey: queryKeys.alerts() });
    setSelected(new Set());
  };

  const bulkSilence = async (durationMinutes: number | 'resolved') => {
    const ids = [...selected];
    await runAll(ids, id => `/alerts/${id}/silence`, 'POST', { durationMinutes });
  };
  const bulkUnsilence = async () => {
    const ids = [...selected];
    await runAll(ids, id => `/alerts/${id}/silence`, 'DELETE');
  };
  const bulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} alert${ids.length === 1 ? '' : 's'}?`,
      message: 'Resolved alerts only. Active alerts are skipped automatically.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await runAll(ids, id => `/alerts/${id}`, 'DELETE');
  };

  // ─────── Render ───────

  const total = data?.total ?? 0;
  const alerts = data?.alerts ?? [];
  const pageMax = Math.max(...alerts.map(a => durationOf(a)), 1);
  const showingStart = alerts.length === 0 ? 0 : filters.offset + 1;
  const showingEnd = filters.offset + alerts.length;

  const monitorItems = useMemo(() => (data?.counts.byHost ?? []).map(h => ({
    id: h.host_id, label: h.host_id, count: h.count,
  })), [data]);

  const namespaceItems = useMemo(() => (data?.counts.byNamespace ?? []).map(n => ({
    id: n.namespace, label: n.namespace, count: n.count,
  })), [data]);

  return (
    <>
      <PageTitle subtitle="Explore alerts from your monitors and checks.">Alerts</PageTitle>

      {/* Search + refresh row */}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={filters.q}
            onChange={(e) => updateFilters({ q: e.target.value })}
            placeholder="Search by type, target, message, host…"
            className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-info/40"
          />
        </div>
        <Button size="sm" variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? '…' : '⟳'} Refresh
        </Button>
      </div>

      {/* Rail + table */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
        <FacetRail
          filters={filters}
          counts={data?.counts}
          monitors={monitorItems}
          namespaces={namespaceItems}
          onChange={updateFilters}
        />

        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm text-secondary">
              Showing <span className="font-semibold text-fg tabular-nums">{showingStart}–{showingEnd}</span>
              {' of '}
              <span className="font-semibold text-fg tabular-nums">{total}</span>
              {' alert'}{total === 1 ? '' : 's'}
            </div>
            {isAuthenticated && (
              <button
                type="button"
                onClick={() => { setSelectMode(s => !s); setSelected(new Set()); }}
                className="text-xs text-muted transition-colors hover:text-fg"
              >
                {selectMode ? 'Cancel selection' : 'Select'}
              </button>
            )}
          </div>

          {selectMode && selected.size > 0 && (
            <BulkBar
              count={selected.size}
              onSilence={bulkSilence}
              onUnsilence={bulkUnsilence}
              onDelete={bulkDelete}
              onClear={() => setSelected(new Set())}
            />
          )}

          {!data ? (
            <LoadingState />
          ) : (
            <AlertsTable
              alerts={alerts}
              durationMax={pageMax}
              selectMode={selectMode}
              selected={selected}
              allOnPageSelected={alerts.length > 0 && alerts.every(a => selected.has(a.id))}
              onToggleOne={toggleOne}
              onToggleAll={toggleAllOnPage}
              onNavigate={(a) => navigate(alertDetailHref(a))}
            />
          )}

          <Pagination
            offset={filters.offset}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={(offset) => updateFilters({ offset })}
          />
        </div>
      </div>

      <ConfirmDialog {...dialogProps} />
    </>
  );
}

// ───────────────────────── Facet rail ─────────────────────────

interface FacetItem<T extends string = string> { id: T; label: string; count: number; icon?: React.ReactNode }

function FacetGroup<T extends string>({
  title, items, selected, onToggle,
}: {
  title: string;
  items: FacetItem<T>[];
  selected: T[];
  onToggle: (id: T) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <ul className="space-y-1.5">
        {items.map(it => {
          const on = selected.includes(it.id);
          return (
            <li key={it.id}>
              <label className="group flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(it.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                />
                {it.icon && <span className="w-4 text-center text-xs">{it.icon}</span>}
                <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium text-fg' : 'text-secondary group-hover:text-fg'}`}>
                  {it.label}
                </span>
                <span className="text-[11px] tabular-nums text-muted">{it.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FacetRail({
  filters, counts, monitors, namespaces, onChange,
}: {
  filters: Filters;
  counts?: AlertsExploreResponse['counts'];
  monitors: FacetItem[];
  namespaces: FacetItem[];
  onChange: (patch: Partial<Filters>) => void;
}) {
  const toggleList = <T extends string>(list: T[], id: T): T[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  const toggleSingle = <T extends string>(current: T | null, id: T): T | null =>
    current === id ? null : id;

  const statusItems: FacetItem<'active' | 'resolved'>[] = [
    { id: 'active',   label: 'Active',   count: counts?.byStatus.active ?? 0,   icon: <span className="inline-block h-2 w-2 rounded-full bg-danger" /> },
    { id: 'resolved', label: 'Resolved', count: counts?.byStatus.resolved ?? 0, icon: <span className="inline-block h-2 w-2 rounded-full bg-success" /> },
  ];
  const levelItems: FacetItem<AlertLevel>[] = (['critical', 'error', 'warning', 'info'] as const).map(l => ({
    id: l, label: LEVEL_STYLES[l].label, count: counts?.byLevel[l] ?? 0,
    icon: <span className={`${LEVEL_STYLES[l].glyphClass} text-[10px]`}>{LEVEL_STYLES[l].glyph}</span>,
  }));
  const mutedItems: FacetItem<'true' | 'false'>[] = [
    { id: 'false', label: 'Not muted', count: counts?.byMuted.not_muted ?? 0, icon: '🔔' },
    { id: 'true',  label: 'Muted',     count: counts?.byMuted.muted ?? 0,     icon: '🔕' },
  ];

  return (
    <aside className="pt-1">
      <FacetGroup
        title="Monitor"
        items={monitors}
        selected={filters.hosts}
        onToggle={(id) => onChange({ hosts: toggleList(filters.hosts, id) })}
      />
      {/* Namespace facet auto-hides on Docker-only fleets (empty items → null). */}
      <FacetGroup
        title="Namespace"
        items={namespaces}
        selected={filters.namespaces}
        onToggle={(id) => onChange({ namespaces: toggleList(filters.namespaces, id) })}
      />
      {/* Status is single-select — Active and Ended are exclusive. */}
      <FacetGroup
        title="Status"
        items={statusItems}
        selected={filters.status ? [filters.status] : []}
        onToggle={(id) => onChange({ status: toggleSingle(filters.status, id) })}
      />
      <FacetGroup
        title="Level"
        items={levelItems}
        selected={filters.levels}
        onToggle={(id) => onChange({ levels: toggleList(filters.levels, id) })}
      />
      {/* Muted is also single-select. */}
      <FacetGroup
        title="Muted"
        items={mutedItems}
        selected={filters.muted == null ? [] : [String(filters.muted) as 'true' | 'false']}
        onToggle={(id) => {
          const bool = id === 'true';
          onChange({ muted: filters.muted === bool ? null : bool });
        }}
      />
    </aside>
  );
}

// ───────────────────────── Table ─────────────────────────

function AlertsTable({
  alerts, durationMax, selectMode, selected, allOnPageSelected,
  onToggleOne, onToggleAll, onNavigate,
}: {
  alerts: (Alert & { level: AlertLevel })[];
  durationMax: number;
  selectMode: boolean;
  selected: Set<number>;
  allOnPageSelected: boolean;
  onToggleOne: (id: number) => void;
  onToggleAll: () => void;
  onNavigate: (a: Alert) => void;
}) {
  if (alerts.length === 0) {
    return (
      <Card>
        <p className="py-6 text-center text-sm text-muted">No alerts match your filters.</p>
      </Card>
    );
  }

  const gridCols = selectMode
    ? 'grid-cols-[28px_72px_64px_112px_40px_112px_112px_140px_1fr]'
    : 'grid-cols-[72px_64px_112px_40px_112px_112px_140px_1fr]';

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className={`grid ${gridCols} items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted`}>
        {selectMode && (
          <input
            type="checkbox"
            checked={allOnPageSelected}
            onChange={onToggleAll}
            aria-label="Select all on this page"
          />
        )}
        <div />
        <div>Status</div>
        <div>Level</div>
        <div>Muted</div>
        <div>Start</div>
        <div>End</div>
        <div>Duration</div>
        <div>Monitor</div>
      </div>
      <div className="divide-y divide-border-light">
        {alerts.map(a => {
          const active = a.resolved_at == null;
          const mutedUntilResolved = a.silenced_until === UNTIL_RESOLVED_SENTINEL;
          const duration = durationOf(a);
          return (
            <div
              key={a.id}
              className={`grid ${gridCols} items-center gap-2 px-3 py-2 text-xs transition-colors ${selected.has(a.id) ? 'bg-info/5' : 'hover:bg-bg-secondary/60'}`}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => onToggleOne(a.id)}
                  aria-label={`Select alert ${a.id}`}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <button
                type="button"
                onClick={() => onNavigate(a)}
                className="justify-self-start rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-info hover:bg-info/5"
              >
                View
              </button>
              <StatusBadge active={active} />
              <LevelPill level={a.level} />
              <div className="text-muted" title={a.silenced_until ?? ''}>
                {a.silenced_until ? (mutedUntilResolved ? '🔕' : '🔕') : ''}
              </div>
              <div className="font-mono tabular-nums text-secondary" title={a.triggered_at}>
                {formatDT(a.triggered_at)}
              </div>
              <div className="font-mono tabular-nums text-secondary" title={a.resolved_at ?? ''}>
                {a.resolved_at ? formatDT(a.resolved_at) : '—'}
              </div>
              <div className="flex items-center gap-2">
                <DurationBar durationSec={duration} max={durationMax} />
                <span className="font-mono tabular-nums text-secondary">{fmtDurationMs(duration * 1000)}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                {(() => {
                  const ns = getContainerNamespace(a.target);
                  const tail = ns ? getContainerDisplayName(a.target) : null;
                  const titleTail = ns ? ` · ${ns}/${tail}` : '';
                  return (
                    <span className="truncate text-secondary" title={`${formatAlertType(a.alert_type)} · ${a.host_id}${titleTail}`}>
                      <span className="font-medium text-fg">{formatAlertType(a.alert_type)}</span>
                      <span className="mx-1 text-muted">·</span>
                      <span className="font-mono text-muted">{a.host_id}</span>
                      {ns && (
                        <>
                          <span className="mx-1 text-muted">·</span>
                          <span className="font-mono text-muted">{ns}</span>
                        </>
                      )}
                    </span>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Pagination ─────────────────────────

function Pagination({
  offset, pageSize, total, onChange,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize) return null;
  const page = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const prev = () => onChange(Math.max(0, offset - pageSize));
  const next = () => onChange(Math.min((pageCount - 1) * pageSize, offset + pageSize));
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm">
      <Button size="sm" variant="secondary" onClick={prev} disabled={page === 1}>
        ← Prev
      </Button>
      <span className="tabular-nums text-muted">
        Page {page} of {pageCount}
      </span>
      <Button size="sm" variant="secondary" onClick={next} disabled={page >= pageCount}>
        Next →
      </Button>
    </div>
  );
}

// ───────────────────────── Bulk toolbar ─────────────────────────

const SILENCE_PRESETS: { label: string; duration: number | 'resolved'; title: string }[] = [
  { label: '1h', duration: 60, title: 'Silence for 1 hour' },
  { label: '4h', duration: 240, title: 'Silence for 4 hours' },
  { label: '1d', duration: 1440, title: 'Silence for 1 day' },
  { label: '7d', duration: 10080, title: 'Silence for 7 days' },
  { label: '∞',  duration: 'resolved', title: 'Silence until resolved' },
];

function BulkBar({
  count, onSilence, onUnsilence, onDelete, onClear,
}: {
  count: number;
  onSilence: (duration: number | 'resolved') => void;
  onUnsilence: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-sm">
      <span className="font-medium text-fg">{count} selected</span>
      <span className="mx-1 text-muted">·</span>
      <span className="text-xs text-muted">Silence:</span>
      {SILENCE_PRESETS.map(p => (
        <button
          key={p.label}
          type="button"
          title={p.title}
          onClick={() => onSilence(p.duration)}
          className="rounded border border-border bg-surface px-2 py-0.5 text-xs hover:bg-bg-secondary"
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onUnsilence}
        className="rounded border border-border bg-surface px-2 py-0.5 text-xs hover:bg-bg-secondary"
      >
        Unsilence
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs text-danger hover:bg-danger/15"
      >
        Delete
      </button>
      <div className="ml-auto">
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-muted hover:text-fg"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
