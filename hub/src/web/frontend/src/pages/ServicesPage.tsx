import { useQuery } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ServiceGroupSummary } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Badge } from '@/components/Badge';
import { useShowInternal } from '@/hooks/useShowInternal';
import { PageTitle } from '@/components/PageTitle';
import { EmptyState } from '@/components/EmptyState';

export function ServicesPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data: groups } = useQuery({ queryKey: queryKeys.groups(showInternal), queryFn: () => api<ServiceGroupSummary[]>(`/groups${si}`), refetchInterval: 30_000 });

  return (
    <div className="space-y-6">
      <PageTitle actions={isAuthenticated ? (
        <Link to="/services/new" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Create Group
        </Link>
      ) : undefined}>Services</PageTitle>

      {!groups || groups.length === 0 ? (
        <EmptyState message="No service groups yet. Groups are auto-created from Docker Compose projects and insightd.group labels, or you can create them manually." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(g => (
            <div
              key={g.id}
              onClick={() => navigate(`/services/${g.id}`)}
              className="cursor-pointer rounded-xl p-4 hover-surface bg-surface border border-border"
              style={{ borderLeft: `4px solid ${g.color || 'var(--color-info)'}` }}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fg">
                  {g.icon && <span className="mr-1.5">{g.icon}</span>}
                  {g.name}
                </span>
                <Badge text={g.source} color={g.source === 'manual' ? 'blue' : g.source === 'compose' ? 'green' : 'yellow'} />
              </div>
              {g.description && (
                <p className="mt-1 text-xs text-muted">{g.description}</p>
              )}
              <div className="mt-3 flex items-center gap-4 text-xs text-secondary">
                <span>
                  <span className={`font-semibold ${g.running_count === g.member_count ? 'text-emerald-500' : 'text-red-500'}`}>
                    {g.running_count}/{g.member_count}
                  </span> running
                </span>
                {g.total_cpu != null && <span>CPU {g.total_cpu}%</span>}
                {g.total_memory != null && <span>{Math.round(g.total_memory)} MB</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
