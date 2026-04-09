import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ServiceGroupSummary } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Badge } from '@/components/Badge';
import { LinkButton } from '@/components/FormField';
import { useShowInternal } from '@/hooks/useShowInternal';
import { PageTitle } from '@/components/PageTitle';
import { EmptyState } from '@/components/EmptyState';

export function StacksPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data: groups } = useQuery({ queryKey: queryKeys.groups(showInternal), queryFn: () => api<ServiceGroupSummary[]>(`/groups${si}`), refetchInterval: 30_000 });

  return (
    <div className="space-y-6">
      <PageTitle
        subtitle="Container groups that work together — auto-detected from Docker Compose, or create your own."
        actions={isAuthenticated ? (
          <LinkButton to="/stacks/new" variant="primary">
            Create Stack
          </LinkButton>
        ) : undefined}
      >Stacks</PageTitle>

      {!groups || groups.length === 0 ? (
        <EmptyState message="No stacks yet. Stacks are auto-created from Docker Compose projects and insightd.group labels, or you can create them manually." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(g => (
            <div
              key={g.id}
              onClick={() => navigate(`/stacks/${g.id}`)}
              className="cursor-pointer rounded-xl p-4 hover-surface card-interactive bg-surface border border-border"
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
                  <span className={`font-semibold ${g.running_count === g.member_count ? 'text-success' : 'text-danger'}`}>
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
