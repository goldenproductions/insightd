import { useQuery, useMutation } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { useState } from 'react';

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

export function UpdatesPage() {
  const { isAuthenticated, token } = useAuth();
  const [results, setResults] = useState<Record<string, { status: string; message?: string; error?: string }>>({});

  const { data: version } = useQuery({ queryKey: ['version-check'], queryFn: () => api<VersionInfo>('/version-check') });
  const { data: hosts } = useQuery({ queryKey: ['hosts'], queryFn: () => api<Host[]>('/hosts') });

  const updateAgent = useMutation({
    mutationFn: async (hostId: string) => {
      setResults(prev => ({ ...prev, [hostId]: { status: 'updating' } }));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const res = await fetch(`/api/update/agent/${encodeURIComponent(hostId)}`, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        clearTimeout(timeout);
        return await res.json() as { status: string; message?: string; error?: string };
      } catch {
        clearTimeout(timeout);
        return { status: 'failed', error: 'Timed out — image pull may be slow, or agent doesn\'t support remote updates (needs v0.2.0+)' };
      }
    },
    onSuccess: (data, hostId) => setResults(prev => ({ ...prev, [hostId]: data })),
    onError: (err, hostId) => setResults(prev => ({ ...prev, [hostId]: { status: 'failed', error: err instanceof Error ? err.message : 'Failed' } })),
  });

  const updateAll = useMutation({
    mutationFn: () => apiAuth<{ results: { hostId: string; status: string; error?: string }[] }>('POST', '/update/agents', undefined, token),
    onSuccess: (data) => {
      const map: Record<string, { status: string; error?: string }> = {};
      for (const r of data.results) map[r.hostId] = r;
      setResults(prev => ({ ...prev, ...map }));
    },
  });

  const [hubStatus, setHubStatus] = useState<'idle' | 'updating' | 'restarting' | 'done' | 'failed'>('idle');
  const [hubError] = useState('');

  const startHubUpdate = async () => {
    setHubStatus('updating');
    try {
      await apiAuth('POST', '/update/hub', undefined, token);
    } catch {
      // Expected — hub may go down during the request
    }
    // Hub will restart — poll for it to come back
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
    setTimeout(() => clearInterval(poll), 120000);
  };

  const latestAgent = version?.latestAgentVersion;
  const latestHub = version?.latestHubVersion;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Updates</h1>

      {/* Version info */}
      <Card title="Version">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-3">
            <span style={{ color: 'var(--text-muted)' }}>Hub:</span>
            <Badge text={`v${version?.currentVersion || '?'}`} color="blue" />
            {latestHub && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <Badge text={`v${latestHub}`} color={version?.hubUpdateAvailable ? 'green' : 'blue'} />
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span style={{ color: 'var(--text-muted)' }}>Agent:</span>
            {latestAgent ? (
              <Badge text={`v${latestAgent}`} color="blue" />
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Checking...</span>
            )}
          </div>
          {version?.hubUpdateAvailable && (
            <AlertBanner message={`Hub v${latestHub} is available!`} color="green" />
          )}
          {!version?.hubUpdateAvailable && latestHub && (
            <p style={{ color: 'var(--color-success)' }}>Hub is up to date.</p>
          )}
        </div>
      </Card>

      {/* Hub update */}
      {isAuthenticated && version?.hubUpdateAvailable && (
        <Card title="Hub">
          {hubStatus === 'idle' && (
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text)' }}>Update hub to v{latestHub}</span>
              <Button onClick={startHubUpdate}>Update Hub</Button>
            </div>
          )}
          {hubStatus === 'updating' && <AlertBanner message="Sending update command to agent..." color="yellow" />}
          {hubStatus === 'restarting' && <AlertBanner message="Hub is restarting. This page will reload automatically when it's back..." color="yellow" />}
          {hubStatus === 'done' && <AlertBanner message="Hub updated! Reloading..." color="green" />}
          {hubStatus === 'failed' && <AlertBanner message={hubError || 'Hub update failed'} color="red" />}
        </Card>
      )}

      {/* Agent updates */}
      <Card title="Agents">
        {isAuthenticated && (hosts || []).some(h => latestAgent && h.agent_version && h.agent_version !== latestAgent) && (
          <div className="mb-4 flex justify-end">
            <Button onClick={() => updateAll.mutate()} disabled={updateAll.isPending}>
              {updateAll.isPending ? 'Updating All...' : 'Update All Agents'}
            </Button>
          </div>
        )}
        <div className="space-y-3">
          {(hosts || []).map(h => {
            const result = results[h.host_id];
            const isOutdated = latestAgent && h.agent_version && h.agent_version !== latestAgent;
            return (
              <div key={h.host_id} className="flex items-center justify-between rounded-lg p-3" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text)' }}>
                    <span className={`h-2 w-2 rounded-full ${h.is_online ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    {h.host_id}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {h.agent_version ? (
                      <Badge text={`v${h.agent_version}`} color={isOutdated ? 'yellow' : 'green'} />
                    ) : (
                      <span>Version unknown</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {result && (
                    <span className={`text-xs ${result.status === 'success' ? 'text-emerald-500' : result.status === 'updating' ? 'text-amber-500' : 'text-red-500'}`}>
                      {result.status === 'success' ? 'Updated' : result.status === 'updating' ? 'Updating...' : result.error || 'Failed'}
                    </span>
                  )}
                  {isAuthenticated && isOutdated && h.is_online && (
                    <Button onClick={() => updateAgent.mutate(h.host_id)} disabled={updateAgent.isPending}>
                      Update
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
