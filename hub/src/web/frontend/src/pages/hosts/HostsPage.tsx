import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, apiAuth } from '@/lib/api';
import type { Host, ContainerSnapshot, DashboardData } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { timeAgo } from '@/lib/formatters';
import { useAuth } from '@/context/AuthContext';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import { Card } from '@/components/Card';
import { Button } from '@/components/FormField';
import { queryKeys } from '@/lib/queryKeys';

/**
 * "Ungrouped" is a virtual column — hosts fall into it when their effective
 * group (`COALESCE(host_group_override, host_group)`) resolves to an empty
 * string. Dropping a host on this column sends `host_group: null` to the
 * API, which the handler normalises to an empty-string override — the
 * "manually ungrouped" state.
 */
const UNGROUPED_ID = '__ungrouped__';
const UNGROUPED_LABEL = 'Ungrouped';

function effectiveGroup(h: Host): string | null {
  const override = h.host_group_override;
  if (override === '' ) return null; // manually ungrouped
  if (override && override.length > 0) return override;
  if (h.host_group && h.host_group.length > 0) return h.host_group;
  return null;
}

export function HostsPage() {
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();

  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<Host[]>('/hosts'),
    refetchInterval: 30_000,
  });
  const { data: dash } = useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: () => api<DashboardData>('/dashboard'),
    refetchInterval: 30_000,
  });

  // ────────────────────── Grouping ──────────────────────

  const [pendingGroups, setPendingGroups] = useState<string[]>([]);
  const [drag, setDrag] = useState<{ hostId: string } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const setGroupMutation = useMutation({
    mutationFn: ({ hostId, group }: { hostId: string; group: string | null }) =>
      apiAuth('PUT', `/hosts/${encodeURIComponent(hostId)}/group`, { host_group: group }, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hosts() });
    },
  });

  const renameGroupMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      apiAuth('PUT', `/host-groups/${encodeURIComponent(oldName)}`, { name: newName }, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hosts() });
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (name: string) =>
      apiAuth('DELETE', `/host-groups/${encodeURIComponent(name)}`, undefined, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hosts() });
    },
  });

  const groups = useMemo(() => {
    const seen = new Map<string, Host[]>();
    for (const h of hosts ?? []) {
      const g = effectiveGroup(h) ?? UNGROUPED_ID;
      const list = seen.get(g);
      if (list) list.push(h);
      else seen.set(g, [h]);
    }
    // Ensure pending (empty, user-created) groups appear as columns too
    for (const name of pendingGroups) {
      if (!seen.has(name)) seen.set(name, []);
    }
    // Stable order: named groups alphabetical, Ungrouped last
    const entries = Array.from(seen.entries());
    entries.sort(([a], [b]) => {
      if (a === UNGROUPED_ID) return 1;
      if (b === UNGROUPED_ID) return -1;
      return a.localeCompare(b);
    });
    // Always include Ungrouped column so users have a drop target
    if (!seen.has(UNGROUPED_ID)) entries.push([UNGROUPED_ID, []]);
    return entries;
  }, [hosts, pendingGroups]);

  const onDrop = (columnId: string) => {
    setHovered(null);
    if (!drag) return;
    const target = columnId === UNGROUPED_ID ? null : columnId;
    setGroupMutation.mutate({ hostId: drag.hostId, group: target });
    // Clear the pending marker once a host lands in it — the group is now
    // persisted via the host's override.
    if (target && pendingGroups.includes(target)) {
      setPendingGroups(prev => prev.filter(n => n !== target));
    }
    setDrag(null);
  };

  const addGroup = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === UNGROUPED_LABEL) return;
    // If a column already exists (because a host is in it), this is a no-op
    const already = groups.some(([id]) => id === trimmed);
    if (!already) setPendingGroups(prev => [...prev, trimmed]);
  };

  const renameGroup = (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName || trimmed === UNGROUPED_LABEL) return;
    // Pending (no hosts yet) — just rename the marker
    if (pendingGroups.includes(oldName)) {
      setPendingGroups(prev => prev.map(n => n === oldName ? trimmed : n));
      return;
    }
    renameGroupMutation.mutate({ oldName, newName: trimmed });
  };

  const deleteGroup = (name: string) => {
    if (pendingGroups.includes(name)) {
      setPendingGroups(prev => prev.filter(n => n !== name));
      return;
    }
    if (!window.confirm(`Delete group "${name}"? Its hosts move to Ungrouped.`)) return;
    deleteGroupMutation.mutate(name);
  };

  // ────────────────────── Stats ──────────────────────

  const onlineCount = (hosts ?? []).filter(h => h.is_online).length;
  const totalContainers = dash?.totalContainers ?? 0;
  const runningContainers = dash?.containersRunning ?? 0;

  if (!hosts) return <LoadingState />;

  return (
    <div className="space-y-6">
      <PageTitle subtitle="Your machines, grouped as you like.">Hosts</PageTitle>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatTile title="Online" value={`${onlineCount}/${hosts.length}`} sub={hosts.length === 0 ? 'No hosts connected yet' : `${hosts.length - onlineCount} offline`} />
        <StatTile title="Containers" value={String(totalContainers)} sub={`${runningContainers} running`} />
      </div>

      {hosts.length === 0 ? (
        <EmptyState message="No hosts connected yet" />
      ) : (
        <Card
          title="Groups"
          actions={isAuthenticated ? <NewGroupButton onCreate={addGroup} /> : null}
        >
          <p className="mb-3 text-xs text-muted">
            Drag hosts between groups to organise them. Hosts without a group stay in Ungrouped.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {groups.map(([id, members]) => (
              <GroupColumn
                key={id}
                label={id === UNGROUPED_ID ? UNGROUPED_LABEL : id}
                editable={isAuthenticated && id !== UNGROUPED_ID}
                members={members}
                hovered={hovered === id}
                dragActive={drag !== null}
                onHostDragStart={(hostId) => setDrag({ hostId })}
                onHostDragEnd={() => { setDrag(null); setHovered(null); }}
                onDragOver={(e) => { e.preventDefault(); setHovered(id); }}
                onDragLeave={() => setHovered(null)}
                onDrop={() => onDrop(id)}
                onHostClick={(hostId) => navigate(`/hosts/${encodeURIComponent(hostId)}`)}
                onRename={(newName) => renameGroup(id, newName)}
                onDelete={() => deleteGroup(id)}
                authed={isAuthenticated}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function StatTile({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 lg:p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">{title}</h3>
      <div className="mt-1 text-2xl font-bold text-fg tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function NewGroupButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + New group
      </Button>
    );
  }

  const submit = () => {
    if (value.trim()) onCreate(value);
    setValue('');
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setValue(''); setOpen(false); }
        }}
        onBlur={submit}
        placeholder="Group name"
        className="rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-info/40"
      />
    </div>
  );
}

interface GroupColumnProps {
  label: string;
  /** True for user-editable group columns (not the virtual "Ungrouped"). */
  editable: boolean;
  members: Host[];
  hovered: boolean;
  dragActive: boolean;
  onHostDragStart: (hostId: string) => void;
  onHostDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onHostClick: (hostId: string) => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
  authed: boolean;
}

function GroupColumn({ label, editable, members, hovered, dragActive, onHostDragStart, onHostDragEnd, onDragOver, onDragLeave, onDrop, onHostClick, onRename, onDelete, authed }: GroupColumnProps) {
  const tone = members.length === 0 ? 'bg-muted' : members.every(h => h.is_online) ? 'bg-success' : 'bg-warning';
  const ringClass = hovered ? 'border-info bg-info/5' : 'border-border bg-bg-secondary';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  return (
    <div
      onDragOver={authed ? onDragOver : undefined}
      onDragLeave={authed ? onDragLeave : undefined}
      onDrop={authed ? onDrop : undefined}
      className={`group/column rounded-xl border p-3 transition-colors ${ringClass}`}
    >
      <div className="mb-2 flex items-center justify-between gap-1 px-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== label) onRename(draft.trim()); else setDraft(label); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                if (e.key === 'Escape') { setDraft(label); setEditing(false); }
              }}
              className="min-w-0 flex-1 truncate rounded border border-info/40 bg-surface px-1 text-sm font-semibold text-fg focus:outline-none"
            />
          ) : (
            <button
              type="button"
              disabled={!editable}
              onClick={() => { if (editable) { setDraft(label); setEditing(true); } }}
              className={`min-w-0 truncate text-left text-sm font-semibold text-fg ${editable ? 'cursor-text rounded hover:underline' : ''}`}
              title={editable ? 'Click to rename' : undefined}
            >
              {label}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs tabular-nums text-muted">{members.length}</span>
          {editable && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete group ${label}`}
              title="Delete group"
              className="rounded px-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover/column:opacity-100 focus:opacity-100"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="flex min-h-[72px] flex-col gap-1.5">
        {members.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            {dragActive ? 'Drop host here' : 'Empty'}
          </div>
        ) : (
          members.map(h => (
            <HostRow
              key={h.host_id}
              host={h}
              draggable={authed}
              onDragStart={() => onHostDragStart(h.host_id)}
              onDragEnd={onHostDragEnd}
              onClick={() => onHostClick(h.host_id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface HostRowProps {
  host: Host;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}

function HostRow({ host, draggable, onDragStart, onDragEnd, onClick }: HostRowProps) {
  const { data: containers } = useQuery({
    queryKey: queryKeys.hostContainers(host.host_id),
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(host.host_id)}/containers`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const running = containers?.filter(c => c.status === 'running').length ?? 0;
  const total = containers?.length ?? 0;

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', host.host_id); // for browsers that require it
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors hover-surface ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      {draggable && (
        <span aria-hidden="true" className="select-none text-xs leading-none text-muted/60 group-hover:text-muted">⋮⋮</span>
      )}
      <StatusDot status={host.is_online ? 'online' : 'offline'} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate">
          <span className="truncate text-sm font-semibold text-fg">{host.host_id}</span>
          {host.proxmox && (
            <span className="shrink-0 rounded border border-border bg-bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px] text-secondary">
              {host.proxmox.node}:{host.proxmox.vmid}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted">
          {host.runtime_type ?? 'host'} · {host.is_online ? `seen ${timeAgo(host.last_seen)}` : `offline ${timeAgo(host.last_seen)}`}
        </div>
      </div>
      <div className="shrink-0 text-right text-[11px] tabular-nums text-muted">
        {running}/{total}
      </div>
    </div>
  );
}
