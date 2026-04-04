import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { useState } from 'react';
import { Link } from 'react-router-dom';

interface VersionInfo {
  currentVersion: string;
  latestHubVersion: string | null;
  latestAgentVersion: string | null;
  hubUpdateAvailable: boolean;
  checkedAt: string | null;
  // backward compat
  latestVersion: string | null;
  updateAvailable: boolean;
}

interface Host {
  host_id: string;
  agent_version: string | null;
  is_online: number;
}

interface ImageUpdate {
  host_id: string;
  container_name: string;
  image: string;
  checked_at: string;
}

type UpdateResult = { status: string; message?: string; error?: string };

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

  const [hubStatus, setHubStatus] = useState<'idle' | 'updating' | 'restarting' | 'done' | 'failed'>('idle');
  const [hubError, setHubError] = useState('');

  const startHubUpdate = async () => {
    setHubStatus('updating');
    setHubError('');
    try {
      const res = await fetch('/api/update/hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHubStatus('failed');
        setHubError(data.error || `Server returned ${res.status}`);
        return;
      }
    } catch {
      // Expected — hub may go down during the request
    }
    setHubStatus('restarting');
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          clearInterval(poll);
          setHubStatus('done');
          setTimeout(() => window.location.reload(), 2000);
        }
      } catch { /* hub still down */ }
    }, 3000);
    setTimeout(() => {
      clearInterval(poll);
      setHubStatus((prev) => prev === 'restarting' ? 'failed' : prev);
      setHubError('Hub did not come back within 2 minutes. Check the container logs.');
    }, 120000);
  };

  const latestAgent = version?.latestAgentVersion;
  const latestHub = version?.latestHubVersion;
  const checkedAt = version?.checkedAt ? new Date(version.checkedAt).toLocaleString() : null;

  const outdatedAgents = (hosts || []).filter(h => latestAgent && h.agent_version && h.agent_version !== latestAgent);
  const hasOutdatedOnline = outdatedAgents.some(h => h.is_online);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Updates</h1>

      {/* Version info */}
      <Card title="Version">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-12 font-medium" style={{ color: 'var(--text)' }}>Hub</span>
              <Badge text={`v${version?.currentVersion || '?'}`} color="blue" />
              {latestHub && latestHub !== version?.currentVersion && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                  <Badge text={`v${latestHub}`} color="green" />
                </>
              )}
            </div>
            {latestHub && (
              <span className="text-xs" style={{ color: version?.hubUpdateAvailable ? 'var(--color-warning)' : 'var(--color-success)' }}>
                {version?.hubUpdateAvailable ? 'Update available' : 'Up to date'}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-12 font-medium" style={{ color: 'var(--text)' }}>Agent</span>
              {latestAgent ? (
                <Badge text={`v${latestAgent}`} color="blue" />
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>Checking...</span>
              )}
            </div>
            {latestAgent && (
              <span className="text-xs" style={{ color: outdatedAgents.length > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>
                {outdatedAgents.length > 0
                  ? `${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} outdated`
                  : 'All agents up to date'}
              </span>
            )}
          </div>
          {checkedAt && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Last checked: {checkedAt}</p>
          )}
        </div>
      </Card>

      {/* Hub update */}
      <Card title="Hub">
        {!version?.hubUpdateAvailable && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Running v{version?.currentVersion || '?'} — no update available.
          </p>
        )}
        {version?.hubUpdateAvailable && !isAuthenticated && (
          <AlertBanner message={`Hub v${latestHub} is available. Log in to update.`} color="yellow" />
        )}
        {isAuthenticated && version?.hubUpdateAvailable && (
          <>
            {hubStatus === 'idle' && (
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--text)' }}>Update hub to v{latestHub}</span>
                <Button onClick={startHubUpdate}>Update Hub</Button>
              </div>
            )}
            {hubStatus === 'updating' && <AlertBanner message="Sending update command to local agent..." color="yellow" />}
            {hubStatus === 'restarting' && <AlertBanner message="Hub is restarting — this page will reload automatically when it's back..." color="yellow" />}
            {hubStatus === 'done' && <AlertBanner message="Hub updated! Reloading..." color="green" />}
            {hubStatus === 'failed' && <AlertBanner message={hubError || 'Hub update failed.'} color="red" />}
          </>
        )}
      </Card>

      {/* Agent updates */}
      <Card title="Agents">
        {isAuthenticated && hasOutdatedOnline && (
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
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
              <div key={h.host_id} className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text)' }}>
                      <span className={`h-2 w-2 rounded-full ${h.is_online ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {h.host_id}
                      {!h.is_online && <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>Offline</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      {h.agent_version ? (
                        <>
                          <Badge text={`v${h.agent_version}`} color={isOutdated ? 'yellow' : 'green'} />
                          {isOutdated && latestAgent && (
                            <span style={{ color: 'var(--text-muted)' }}>→ v{latestAgent}</span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>Version unknown (agent may be too old)</span>
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
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-warning)' }}>
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
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No agents connected.</p>
          )}
        </div>
      </Card>

      {/* Container image updates */}
      <Card title="Container Image Updates">
        {(!imageUpdates || imageUpdates.length === 0) ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>All container images are up to date.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {imageUpdates.length} container{imageUpdates.length > 1 ? 's' : ''} with newer images on Docker Hub.
            </p>
            <div className="space-y-2">
              {imageUpdates.map(u => (
                <Link key={`${u.host_id}/${u.container_name}`}
                  to={`/hosts/${encodeURIComponent(u.host_id)}/containers/${encodeURIComponent(u.container_name)}`}
                  className="flex items-center justify-between rounded-lg p-3 hover-border-info"
                  style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                >
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{u.container_name}</div>
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{u.image}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge text={u.host_id} color="blue" />
                    <Badge text="Update available" color="yellow" />
                  </div>
                </Link>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Checked {imageUpdates[0]?.checked_at ? new Date(imageUpdates[0].checked_at + 'Z').toLocaleString() : 'recently'}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
