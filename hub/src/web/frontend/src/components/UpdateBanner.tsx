import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';

interface VersionInfo {
  currentVersion: string;
  latestHubVersion: string | null;
  latestAgentVersion: string | null;
  hubUpdateAvailable: boolean;
  checkedAt: string | null;
}

interface Host {
  host_id: string;
  agent_version: string | null;
  is_online: number;
}

export function UpdateBanner() {
  const { data: version } = useQuery({
    queryKey: ['version-check'],
    queryFn: () => api<VersionInfo>('/version-check'),
    refetchInterval: 30 * 60 * 1000,
  });

  const { data: hosts } = useQuery({
    queryKey: ['hosts'],
    queryFn: () => api<Host[]>('/hosts'),
  });

  const hubOutdated = version?.hubUpdateAvailable;
  const outdatedAgents = (hosts || []).filter(h => version?.latestAgentVersion && h.agent_version && h.agent_version !== version.latestAgentVersion);
  const agentsOutdated = outdatedAgents.length > 0;

  if (!hubOutdated && !agentsOutdated) return null;

  const message = hubOutdated && agentsOutdated
    ? `Hub v${version?.latestHubVersion} and ${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} have updates available.`
    : hubOutdated
    ? `Hub v${version?.latestHubVersion} available. You're running v${version?.currentVersion}.`
    : `${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} running v${outdatedAgents[0]?.agent_version} — latest is v${version?.latestAgentVersion}.`;

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg px-4 py-2.5 text-sm"
      style={{ backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: 'var(--color-info)' }}>
      <span>{message}</span>
      <Link to="/updates" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700">
        Update
      </Link>
    </div>
  );
}
