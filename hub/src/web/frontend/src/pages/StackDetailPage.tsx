import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ServiceGroupDetail, ContainerSnapshot } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { StatCard, StatsGrid } from '@/components/StatCard';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusDot } from '@/components/StatusDot';
import { Badge } from '@/components/Badge';
import { Button, LinkButton } from '@/components/FormField';
import { fmtPercent } from '@/lib/formatters';
import { useState, useMemo } from 'react';
import { BackLink } from '@/components/BackLink';
import { LoadingState } from '@/components/LoadingState';

export function StackDetailPage() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);

  const { data } = useQuery({ queryKey: queryKeys.group(groupId), queryFn: () => api<ServiceGroupDetail>(`/groups/${groupId}`), refetchInterval: 30_000 });

  const removeMutation = useMutation({
    mutationFn: ({ hostId, containerName }: { hostId: string; containerName: string }) =>
      apiAuth('DELETE', `/groups/${groupId}/members`, { hostId, containerName }, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
  });

  const { running, totalCpu, totalMem } = useMemo(() => {
    if (!data) return { running: 0, totalCpu: 0, totalMem: 0 };
    let running = 0, cpu = 0, mem = 0;
    for (const m of data.members) {
      if (m.status === 'running') running++;
      cpu += m.cpu_percent || 0;
      mem += m.memory_mb || 0;
    }
    return { running, totalCpu: cpu, totalMem: mem };
  }, [data]);

  if (!data) return <LoadingState />;

  const columns: Column<typeof data.members[number]>[] = [
    { header: 'Container', accessor: r => <span className="flex items-center gap-2 text-info"><StatusDot status={r.status || 'none'} />{r.container_name}</span> },
    { header: 'Host', accessor: r => <span className="text-info">{r.host_id}</span> },
    { header: 'Status', accessor: r => r.status ? <Badge text={r.status} color={r.status === 'running' ? 'green' : 'red'} /> : '-' },
    { header: 'CPU', accessor: r => fmtPercent(r.cpu_percent) },
    { header: 'Memory', accessor: r => r.memory_mb != null ? `${Math.round(r.memory_mb)} MB` : '-' },
    { header: 'Source', accessor: r => <Badge text={r.source} color={r.source === 'manual' ? 'blue' : 'gray'} /> },
    ...(isAuthenticated ? [{
      header: '',
      accessor: (r: typeof data.members[number]) => (
        <button
          onClick={e => { e.stopPropagation(); removeMutation.mutate({ hostId: r.host_id, containerName: r.container_name }); }}
          className="text-xs text-danger hover:text-danger"
        >Remove</button>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-6">
      <BackLink to="/stacks" label="Back to Stacks" />

      <div className="flex items-center gap-3">
        {data.icon && <span className="text-2xl">{data.icon}</span>}
        <h1 className="text-xl font-bold text-fg">{data.name}</h1>
        {isAuthenticated && (
          <LinkButton to={`/stacks/${groupId}/edit`} variant="primary" size="sm">Edit</LinkButton>
        )}
      </div>
      {data.description && <p className="text-sm text-muted">{data.description}</p>}

      <StatsGrid>
        <StatCard value={data.members.length} label="Containers" />
        <StatCard value={`${running}/${data.members.length}`} label="Running" color={running === data.members.length ? 'var(--color-success)' : 'var(--color-danger)'} />
        <StatCard value={`${Math.round(totalCpu * 10) / 10}%`} label="Total CPU" />
        <StatCard value={`${Math.round(totalMem)} MB`} label="Total Memory" />
      </StatsGrid>

      <Card title="Containers">
        {isAuthenticated && (
          <div className="mb-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAddForm(!showAddForm)}>
              {showAddForm ? 'Cancel' : 'Add Container'}
            </Button>
          </div>
        )}
        {showAddForm && <AddContainerForm groupId={parseInt(groupId!, 10)} token={token} onAdded={() => { setShowAddForm(false); queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId) }); }} />}
        <DataTable
          columns={columns}
          data={data.members}
          onRowClick={r => navigate(`/hosts/${encodeURIComponent(r.host_id)}/containers/${encodeURIComponent(r.container_name)}`)}
          emptyText="No containers in this stack"
        />
      </Card>
    </div>
  );
}

function AddContainerForm({ groupId, token, onAdded }: { groupId: number; token: string | null; onAdded: () => void }) {
  const [hostId, setHostId] = useState('');
  const [containerName, setContainerName] = useState('');

  // Fetch all containers across all hosts
  const { data: hosts } = useQuery({ queryKey: queryKeys.hosts(), queryFn: () => api<{ host_id: string }[]>('/hosts') });
  const { data: allContainers } = useQuery({
    queryKey: queryKeys.allContainers(hosts?.map(h => h.host_id).sort().join(',')),
    queryFn: async () => {
      if (!hosts) return [];
      const results: { hostId: string; name: string }[] = [];
      for (const h of hosts) {
        const containers = await api<ContainerSnapshot[]>(`/hosts/${encodeURIComponent(h.host_id)}/containers`);
        for (const c of containers) results.push({ hostId: h.host_id, name: c.container_name });
      }
      return results;
    },
    enabled: !!hosts,
    refetchInterval: false,
  });

  const add = async () => {
    if (!hostId || !containerName) return;
    await apiAuth('POST', `/groups/${groupId}/members`, { hostId, containerName }, token);
    onAdded();
  };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg p-3 bg-bg-secondary border border-border">
      <select value={`${hostId}|${containerName}`} onChange={e => { const [h, c] = e.target.value.split('|'); setHostId(h || ''); setContainerName(c || ''); }}
        className="rounded-lg px-3 py-2 text-sm bg-surface border border-border text-fg">
        <option value="">Select container...</option>
        {(allContainers || []).map(c => (
          <option key={`${c.hostId}|${c.name}`} value={`${c.hostId}|${c.name}`}>{c.hostId} / {c.name}</option>
        ))}
      </select>
      <Button variant="primary" onClick={add}>Add</Button>
    </div>
  );
}
