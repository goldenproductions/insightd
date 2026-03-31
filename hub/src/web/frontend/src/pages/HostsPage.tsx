import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import type { Host, ContainerSnapshot } from '@/types/api';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';

export function HostsPage() {
  const navigate = useNavigate();
  const { data: hosts } = useQuery({ queryKey: ['hosts'], queryFn: () => api<Host[]>('/hosts') });

  if (!hosts) return <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Hosts</h1>
      {hosts.length === 0 ? (
        <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No hosts connected yet</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map(h => (
            <HostCard key={h.host_id} host={h} onClick={() => navigate(`/hosts/${encodeURIComponent(h.host_id)}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HostCard({ host, onClick }: { host: Host; onClick: () => void }) {
  const { data: containers } = useQuery({
    queryKey: ['host-containers', host.host_id],
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(host.host_id)}/containers`),
  });

  const running = containers?.filter(c => c.status === 'running').length ?? 0;
  const total = containers?.length ?? 0;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-xl p-4 transition-colors"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')}
      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'var(--surface)')}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-semibold" style={{ color: 'var(--text)' }}>
          <StatusDot status={host.is_online ? 'online' : 'offline'} size="md" />
          {host.host_id}
        </span>
        <Badge text={host.is_online ? 'online' : 'offline'} color={host.is_online ? 'green' : 'red'} />
      </div>
      <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        {running}/{total} containers running<br />
        Last seen {timeAgo(host.last_seen)}
      </div>
    </div>
  );
}

function Loading() {
  return <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>;
}
