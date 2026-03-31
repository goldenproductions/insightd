import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Link } from 'react-router-dom';

interface VersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
}

export function UpdateBanner() {
  const { data } = useQuery({
    queryKey: ['version-check'],
    queryFn: () => api<VersionInfo>('/version-check'),
    refetchInterval: 30 * 60 * 1000, // 30 minutes
  });

  if (!data?.updateAvailable) return null;

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg px-4 py-2.5 text-sm"
      style={{ backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: 'var(--color-info)' }}>
      <span>
        insightd <strong>v{data.latestVersion}</strong> is available. You're running v{data.currentVersion}.
      </span>
      <Link to="/updates" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700">
        Update
      </Link>
    </div>
  );
}
