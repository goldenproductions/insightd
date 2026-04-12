import { useState, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { queryKeys } from '@/lib/queryKeys';
import type { HostWithAgent, UpdateResult } from '@/types/api';

interface Props {
  hosts: HostWithAgent[] | undefined;
  latestAgent: string | null | undefined;
}

export function AgentUpdatesCard({ hosts, latestAgent }: Props) {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [results, setResults] = useState<Record<string, UpdateResult>>({});

  const updateAgent = useMutation({
    mutationFn: async (hostId: string) => {
      setResults(prev => ({ ...prev, [hostId]: { status: 'updating', message: 'Sending update command...' } }));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const res = await fetch(`/api/update/agent/${encodeURIComponent(hostId)}`, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        clearTimeout(timeout);
        const data = await res.json() as UpdateResult;
        if (!res.ok) return { status: 'failed', error: data.error || `Server returned ${res.status}` };
        return data;
      } catch {
        clearTimeout(timeout);
        return { status: 'failed', error: 'No response from agent. Check that INSIGHTD_ALLOW_UPDATES=true is set, the agent can reach Docker Hub, and is running v0.2.0+.' };
      }
    },
    onSuccess: (data, hostId) => {
      setResults(prev => ({ ...prev, [hostId]: data }));
      if (data.status === 'success') {
        setTimeout(() => queryClient.invalidateQueries({ queryKey: queryKeys.hosts() }), 10000);
      }
    },
    onError: (err, hostId) => setResults(prev => ({ ...prev, [hostId]: { status: 'failed', error: err instanceof Error ? err.message : 'Failed' } })),
  });

  const updateAll = useMutation({
    mutationFn: async () => {
      const onlineOutdated = (hosts || []).filter(h => h.is_online && latestAgent && h.agent_version && h.agent_version !== latestAgent);
      for (const h of onlineOutdated) {
        setResults(prev => ({ ...prev, [h.host_id]: { status: 'updating', message: 'Queued...' } }));
      }
      return apiAuth<{ results: { hostId: string; status: string; error?: string; message?: string }[] }>('POST', '/update/agents', undefined, token);
    },
    onSuccess: (data) => {
      const map: Record<string, UpdateResult> = {};
      for (const r of data.results) map[r.hostId] = r;
      setResults(prev => ({ ...prev, ...map }));
      setTimeout(() => queryClient.invalidateQueries({ queryKey: queryKeys.hosts() }), 10000);
    },
  });

  const { outdatedAgents, hasOutdatedOnline } = useMemo(() => {
    const outdated: HostWithAgent[] = [];
    let hasOnline = false;
    for (const h of hosts || []) {
      if (latestAgent && h.agent_version && h.agent_version !== latestAgent) {
        outdated.push(h);
        if (h.is_online) hasOnline = true;
      }
    }
    return { outdatedAgents: outdated, hasOutdatedOnline: hasOnline };
  }, [hosts, latestAgent]);

  return (
    <Card title="Agents">
      {isAuthenticated && hasOutdatedOnline && (
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted">
            {outdatedAgents.length} agent{outdatedAgents.length > 1 ? 's' : ''} can be updated to v{latestAgent}
          </span>
          <Button onClick={() => updateAll.mutate()} disabled={updateAll.isPending}>
            {updateAll.isPending ? 'Updating All...' : 'Update All Agents'}
          </Button>
        </div>
      )}
      {!isAuthenticated && outdatedAgents.length > 0 && (
        <div className="mb-4">
          <AlertBanner message={`${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} outdated. Log in to update.`} color="yellow" />
        </div>
      )}
      <div className="space-y-3">
        {(hosts || []).map(h => {
          const result = results[h.host_id];
          const isOutdated = latestAgent && h.agent_version && h.agent_version !== latestAgent;
          const isUpdating = result?.status === 'updating';

          return (
            <div key={h.host_id} className="rounded-lg border border-border bg-bg-secondary p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-fg">
                    <span className={`h-2 w-2 rounded-full ${h.is_online ? 'bg-success' : 'bg-danger'}`} />
                    {h.host_id}
                    {!h.is_online && <span className="text-xs font-normal text-muted">Offline</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    {h.agent_version ? (
                      <>
                        <Badge text={`v${h.agent_version}`} color={isOutdated ? 'yellow' : 'green'} />
                        {isOutdated && latestAgent && (
                          <span className="text-muted">&rarr; v{latestAgent}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted">Version unknown (agent may be too old)</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isAuthenticated && h.is_online && isOutdated && !isUpdating && result?.status !== 'success' && (
                    <Button onClick={() => updateAgent.mutate(h.host_id)} disabled={updateAgent.isPending}>
                      Update
                    </Button>
                  )}
                  {isAuthenticated && h.is_online && !isOutdated && h.agent_version && !isUpdating && result?.status !== 'success' && (
                    <Button variant="secondary" onClick={() => updateAgent.mutate(h.host_id)} disabled={updateAgent.isPending}>
                      Reinstall
                    </Button>
                  )}
                </div>
              </div>
              {result && (
                <div className="mt-2">
                  {result.status === 'updating' && (
                    <div className="flex items-center gap-2 text-xs text-warning">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      {result.message || 'Pulling image and restarting container...'}
                    </div>
                  )}
                  {result.status === 'success' && (
                    <AlertBanner message={result.message || 'Agent updated successfully. It will reconnect shortly.'} color="green" />
                  )}
                  {result.status === 'failed' && (
                    <AlertBanner message={result.error || 'Update failed.'} color="red" />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {(hosts || []).length === 0 && (
          <p className="text-xs text-muted">No agents connected.</p>
        )}
      </div>
    </Card>
  );
}
