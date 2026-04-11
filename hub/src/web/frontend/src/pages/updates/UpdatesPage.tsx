import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { PageTitle } from '@/components/PageTitle';
import { useHubUpdate } from '@/hooks/useHubUpdate';
import { HubUpdateCard } from './HubUpdateCard';
import { AgentUpdatesCard } from './AgentUpdatesCard';
import { ImageUpdatesCard } from './ImageUpdatesCard';
import type { VersionInfo, HostWithAgent, ImageUpdate } from '@/types/api';
import { queryKeys } from '@/lib/queryKeys';

export function UpdatesPage() {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [checkingVersion, setCheckingVersion] = useState(false);

  const { data: version } = useQuery({ queryKey: queryKeys.versionCheck(), queryFn: () => api<VersionInfo>('/version-check') });
  const { data: hosts } = useQuery({ queryKey: queryKeys.hosts(), queryFn: () => api<HostWithAgent[]>('/hosts') });
  const { data: imageUpdates } = useQuery({ queryKey: queryKeys.imageUpdates(), queryFn: () => api<ImageUpdate[]>('/image-updates') });

  const { hubStatus, hubError, startHubUpdate } = useHubUpdate();

  async function handleCheckVersion() {
    setCheckingVersion(true);
    try {
      await apiAuth<VersionInfo>('POST', '/version-check', undefined, token);
      queryClient.invalidateQueries({ queryKey: queryKeys.versionCheck() });
    } catch { /* ignore */ }
    setCheckingVersion(false);
  }

  const latestAgent = version?.latestAgentVersion;
  const latestHub = version?.latestHubVersion;
  const checkedAt = version?.checkedAt ? new Date(version.checkedAt).toLocaleString() : null;
  const outdatedCount = (hosts || []).filter(h => latestAgent && h.agent_version && h.agent_version !== latestAgent).length;

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
              <span className={`text-xs ${outdatedCount > 0 ? 'text-warning' : 'text-success'}`}>
                {outdatedCount > 0
                  ? `${outdatedCount} agent${outdatedCount > 1 ? 's' : ''} outdated`
                  : 'All agents up to date'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {checkedAt && (
              <span className="text-xs text-muted">Last checked: {checkedAt}</span>
            )}
            {isAuthenticated && (
              <Button size="sm" variant="secondary" onClick={handleCheckVersion} disabled={checkingVersion}>
                {checkingVersion ? 'Checking...' : 'Check now'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <HubUpdateCard
        currentVersion={version?.currentVersion}
        latestHub={latestHub}
        hubUpdateAvailable={version?.hubUpdateAvailable}
        hubStatus={hubStatus}
        hubError={hubError}
        startHubUpdate={startHubUpdate}
        isAuthenticated={isAuthenticated}
      />

      <AgentUpdatesCard hosts={hosts} latestAgent={latestAgent} />

      <ImageUpdatesCard imageUpdates={imageUpdates} />
    </div>
  );
}
