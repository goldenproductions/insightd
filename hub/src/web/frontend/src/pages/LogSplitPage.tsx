import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ContainerSnapshot } from '@/types/api';
import { LogViewer } from '@/components/LogViewer';
import { Card } from '@/components/Card';
import { PageTitle } from '@/components/PageTitle';
import { BackLink } from '@/components/BackLink';
import { EmptyState } from '@/components/EmptyState';

export function LogSplitPage() {
  const { hostId } = useParams();
  const hid = encodeURIComponent(hostId!);
  const [selectedContainers, setSelectedContainers] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedContainers), [selectedContainers]);

  const { data: containers } = useQuery({
    queryKey: queryKeys.hostContainers(hostId),
    queryFn: () => api<ContainerSnapshot[]>(`/hosts/${hid}/containers`),
  });

  const toggleContainer = (name: string) => {
    setSelectedContainers(prev =>
      prev.includes(name)
        ? prev.filter(c => c !== name)
        : prev.length >= 4 ? prev : [...prev, name]
    );
  };

  return (
    <div className="space-y-4">
      <BackLink to={`/hosts/${hid}`} label={`Back to ${hostId}`} />

      <PageTitle actions={<span className="text-xs text-muted">Select up to 4 containers</span>}>
        Split Log View
      </PageTitle>

      {/* Container selector */}
      <div className="flex flex-wrap gap-2">
        {(containers || []).map(c => {
          const isSelected = selectedSet.has(c.container_name);
          return (
            <button
              key={c.container_name}
              onClick={() => toggleContainer(c.container_name)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isSelected ? 'bg-blue-600 text-white' : 'bg-surface border border-border text-secondary'
              }`}
            >
              <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${c.status === 'running' ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {c.container_name}
            </button>
          );
        })}
      </div>

      {/* Split panels */}
      {selectedContainers.length === 0 ? (
        <EmptyState message="Select containers above to view their logs side by side" />
      ) : (
        <div className={`grid gap-4 ${
          selectedContainers.length === 1 ? 'grid-cols-1' :
          selectedContainers.length === 2 ? 'grid-cols-1 lg:grid-cols-2' :
          selectedContainers.length === 3 ? 'grid-cols-1 lg:grid-cols-3' :
          'grid-cols-1 lg:grid-cols-2'
        }`}>
          {selectedContainers.map(name => (
            <Card key={name}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg">{name}</h3>
                <button
                  onClick={() => toggleContainer(name)}
                  className="text-xs text-slate-400 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
              <LogViewer hostId={hostId!} containerName={name} compact />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
