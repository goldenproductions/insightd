import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';
import type { VersionInfo, HostWithAgent } from '@/types/api';
import { queryKeys } from '@/lib/queryKeys';

export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('insightd-update-dismissed'));

  const { data: version } = useQuery({
    queryKey: queryKeys.versionCheck(),
    queryFn: () => api<VersionInfo>('/version-check'),
    refetchInterval: 30 * 60 * 1000,
  });

  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<HostWithAgent[]>('/hosts'),
  });

  const hubOutdated = version?.hubUpdateAvailable;
  const outdatedAgents = (hosts || []).filter(h => version?.latestAgentVersion && h.agent_version && h.agent_version !== version.latestAgentVersion);
  const agentsOutdated = outdatedAgents.length > 0;

  if (!hubOutdated && !agentsOutdated) return null;

  // Re-show if a newer version appears since dismissal
  const dismissKey = `${version?.latestHubVersion}|${version?.latestAgentVersion}`;
  if (dismissed === dismissKey) return null;

  const message = hubOutdated && agentsOutdated
    ? `Hub v${version?.latestHubVersion} and ${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} have updates available.`
    : hubOutdated
    ? `Hub v${version?.latestHubVersion} available. You're running v${version?.currentVersion}.`
    : `${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} running v${outdatedAgents[0]?.agent_version} — latest is v${version?.latestAgentVersion}.`;

  const dismiss = () => {
    sessionStorage.setItem('insightd-update-dismissed', dismissKey);
    setDismissed(dismissKey);
  };

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg px-4 py-2.5 text-sm text-info"
      style={{ backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)' }}>

      <span>{message}</span>
      <div className="flex items-center gap-2">
        <Link to="/updates" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700">
          Update
        </Link>
        <button onClick={dismiss} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg" aria-label="Dismiss update notification">
          ✕
        </button>
      </div>
    </div>
  );
}
