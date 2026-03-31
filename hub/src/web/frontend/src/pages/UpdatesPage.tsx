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
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
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
    mutationFn: (hostId: string) => apiAuth<{ status: string; message?: string; error?: string }>('POST', `/update/agent/${encodeURIComponent(hostId)}`, undefined, token),
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

  const updateHub = useMutation({
    mutationFn: () => apiAuth<{ status: string; message?: string; error?: string }>('POST', '/update/hub', undefined, token),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Updates</h1>

      {/* Version info */}
      <Card title="Version">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-3">
            <span style={{ color: 'var(--text-muted)' }}>Current:</span>
            <Badge text={`v${version?.currentVersion || '?'}`} color="blue" />
          </div>
          <div className="flex items-center gap-3">
            <span style={{ color: 'var(--text-muted)' }}>Latest:</span>
            {version?.latestVersion ? (
              <Badge text={`v${version.latestVersion}`} color={version.updateAvailable ? 'green' : 'blue'} />
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Checking...</span>
            )}
          </div>
          {version?.updateAvailable && (
            <AlertBanner message={`Version ${version.latestVersion} is available!`} color="green" />
          )}
          {!version?.updateAvailable && version?.latestVersion && (
            <p style={{ color: 'var(--color-success)' }}>You're up to date.</p>
          )}
        </div>
      </Card>

      {/* Hub update */}
      {isAuthenticated && version?.updateAvailable && (
        <Card title="Hub">
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: 'var(--text)' }}>
              Update hub to v{version.latestVersion}
            </span>
            <Button onClick={() => updateHub.mutate()} disabled={updateHub.isPending}>
              {updateHub.isPending ? 'Updating...' : 'Update Hub'}
            </Button>
          </div>
          {updateHub.isSuccess && <AlertBanner message={updateHub.data?.message || 'Hub updated. It will restart shortly.'} color="green" />}
          {updateHub.isError && <AlertBanner message={updateHub.error instanceof Error ? updateHub.error.message : 'Failed'} color="red" />}
        </Card>
      )}

      {/* Agent updates */}
      <Card title="Agents">
        {isAuthenticated && version?.updateAvailable && (
          <div className="mb-4 flex justify-end">
            <Button onClick={() => updateAll.mutate()} disabled={updateAll.isPending}>
              {updateAll.isPending ? 'Updating All...' : 'Update All Agents'}
            </Button>
          </div>
        )}
        <div className="space-y-3">
          {(hosts || []).map(h => {
            const result = results[h.host_id];
            const isOutdated = version?.latestVersion && h.agent_version && h.agent_version !== version.latestVersion;
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
                    <span className={`text-xs ${result.status === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                      {result.status === 'success' ? 'Updated' : result.error || 'Failed'}
                    </span>
                  )}
                  {isAuthenticated && version?.updateAvailable && h.is_online && (
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
