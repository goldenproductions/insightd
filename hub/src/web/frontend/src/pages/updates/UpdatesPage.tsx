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

/**
 * Compare two semver-ish strings (e.g. "0.15.0" vs "0.16.0"). Returns a
 * negative/0/positive number so the result can drop straight into Array#sort.
 * Tolerates missing components and non-numeric tails (treated as 0).
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

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

  // Pick the OLDEST agent version across the fleet — that's what determines
  // whether anything's outdated. Includes k8s agents for an accurate signal,
  // even though the hub can't auto-update those.
  const agentVersions = (hosts || [])
    .map(h => h.agent_version)
    .filter((v): v is string => Boolean(v));
  const lowestAgent: string | null = agentVersions.length > 0
    ? [...agentVersions].sort(compareSemver)[0] ?? null
    : null;

  const hubAtLatest = !!latestHub && latestHub === version?.currentVersion;
  const agentAllAtLatest = !!latestAgent && !!lowestAgent && lowestAgent === latestAgent;

  return (
    <div className="space-y-6">
      <PageTitle>Updates</PageTitle>

      {/* Version info */}
      <Card title="Version">
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-12 font-medium text-fg">Hub</span>
              {/* Blue = current (when behind), green = latest (or current
                  when already at latest). */}
              <Badge text={`v${version?.currentVersion || '?'}`} color={hubAtLatest ? 'green' : 'blue'} />
              {!!latestHub && !hubAtLatest && (
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
              {lowestAgent ? (
                <>
                  <Badge text={`v${lowestAgent}`} color={agentAllAtLatest ? 'green' : 'blue'} />
                  {!!latestAgent && !agentAllAtLatest && (
                    <>
                      <span className="text-muted">&rarr;</span>
                      <Badge text={`v${latestAgent}`} color="green" />
                    </>
                  )}
                </>
              ) : latestAgent ? (
                <Badge text={`v${latestAgent}`} color="green" />
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
