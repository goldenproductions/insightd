import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { useState, useMemo } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { useHubUpdate } from '@/hooks/useHubUpdate';
import { HubUpdateCard } from './HubUpdateCard';
import { ImageUpdatesCard } from './ImageUpdatesCard';

export interface VersionInfo {
  currentVersion: string;
  latestHubVersion: string | null;
  latestAgentVersion: string | null;
  hubUpdateAvailable: boolean;
  checkedAt: string | null;
  // backward compat
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface Host {
  host_id: string;
  agent_version: string | null;
  is_online: number;
}

export interface ImageUpdate {
  host_id: string;
  container_name: string;
  image: string;
  checked_at: string;
}

export type UpdateResult = { status: string; message?: string; error?: string };

export function UpdatesPage() {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [results, setResults] = useState<Record<string, UpdateResult>>({});

  const { data: version } = useQuery({ queryKey: ['version-check'], queryFn: () => api<VersionInfo>('/version-check') });
  const { data: hosts } = useQuery({ queryKey: ['hosts'], queryFn: () => api<Host[]>('/hosts') });
  const { data: imageUpdates } = useQuery({ queryKey: ['image-updates'], queryFn: () => api<ImageUpdate[]>('/image-updates') });

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
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['hosts'] }), 10000);
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
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['hosts'] }), 10000);
    },
  });

  const { hubStatus, hubError, startHubUpdate } = useHubUpdate();

  const latestAgent = version?.latestAgentVersion;
  const latestHub = version?.latestHubVersion;
  const checkedAt = version?.checkedAt ? new Date(version.checkedAt).toLocaleString() : null;

  const { outdatedAgents, hasOutdatedOnline } = useMemo(() => {
    const outdated: Host[] = [];
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
    <div className="space-y-6">
      <PageTitle>Updates</PageTitle>

      {/* Version info */}
      <Card title="Version">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-12 font-medium text-fg">Hub</span>
              <Badge text={`v${version?.currentVersion || '?'}`} color="blue" />
              {latestHub && latestHub !== version?.currentVersion && (
                <>
                  <span className="text-muted">&rarr;</span>
                  <Badge text={`v${latestHub}`} color="green" />
                </>
              )}
            </div>
            {latestHub && (
              <span className={`text-xs ${version?.hubUpdateAvailable ? 'text-warning' : 'text-success'}`}>
                {version?.hubUpdateAvailable ? 'Update available' : 'Up to date'}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-12 font-medium text-fg">Agent</span>
              {latestAgent ? (
                <Badge text={`v${latestAgent}`} color="blue" />
              ) : (
                <span className="text-muted">Checking...</span>
              )}
            </div>
            {latestAgent && (
              <span className={`text-xs ${outdatedAgents.length > 0 ? 'text-warning' : 'text-success'}`}>
                {outdatedAgents.length > 0
                  ? `${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} outdated`
                  : 'All agents up to date'}
              </span>
            )}
          </div>
          {checkedAt && (
            <p className="text-xs text-muted">Last checked: {checkedAt}</p>
          )}
        </div>
      </Card>

      {/* Hub update */}
      <HubUpdateCard
        currentVersion={version?.currentVersion}
        latestHub={latestHub}
        hubUpdateAvailable={version?.hubUpdateAvailable}
        hubStatus={hubStatus}
        hubError={hubError}
        startHubUpdate={startHubUpdate}
        isAuthenticated={isAuthenticated}
      />

      {/* Agent updates */}
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
              <div key={h.host_id} className="rounded-lg p-3 bg-bg-secondary border border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-fg">
                      <span className={`h-2 w-2 rounded-full ${h.is_online ? 'bg-emerald-500' : 'bg-red-500'}`} />
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
                {/* Update progress / result */}
                {result && (
                  <div className="mt-2">
                    {result.status === 'updating' && (
                      <div className="flex items-center gap-2 text-xs text-warning">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
            <p className="text-sm text-muted">No agents connected.</p>
          )}
        </div>
      </Card>

      {/* Container image updates */}
      <ImageUpdatesCard imageUpdates={imageUpdates} />
    </div>
  );
}
