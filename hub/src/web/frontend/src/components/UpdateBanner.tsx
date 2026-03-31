import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';

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

  const hubOutdated = version?.updateAvailable;
  const outdatedAgents = (hosts || []).filter(h => version?.latestVersion && h.agent_version && h.agent_version !== version.latestVersion);
  const agentsOutdated = outdatedAgents.length > 0;

  if (!hubOutdated && !agentsOutdated) return null;

  const message = hubOutdated && agentsOutdated
    ? `insightd v${version?.latestVersion} available. Hub and ${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} need updating.`
    : hubOutdated
    ? `insightd v${version?.latestVersion} available. You're running v${version?.currentVersion}.`
    : `${outdatedAgents.length} agent${outdatedAgents.length > 1 ? 's' : ''} running v${outdatedAgents[0]?.agent_version} — latest is v${version?.latestVersion}.`;

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
