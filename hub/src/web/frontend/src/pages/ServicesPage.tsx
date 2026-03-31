import { useQuery } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { ServiceGroupSummary } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Badge } from '@/components/Badge';
import { useShowInternal } from '@/lib/useShowInternal';

export function ServicesPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { showInternal } = useShowInternal();
  const si = showInternal ? '?showInternal=true' : '';
  const { data: groups } = useQuery({ queryKey: ['groups', showInternal], queryFn: () => api<ServiceGroupSummary[]>(`/groups${si}`) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Services</h1>
        {isAuthenticated && (
          <Link to="/services/new" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Create Group
          </Link>
        )}
      </div>

      {!groups || groups.length === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No service groups yet. Groups are auto-created from Docker Compose projects and <code>insightd.group</code> labels, or you can create them manually.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(g => (
            <div
              key={g.id}
              onClick={() => navigate(`/services/${g.id}`)}
              className="cursor-pointer rounded-xl p-4 transition-colors"
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                borderLeft: `4px solid ${g.color || 'var(--color-info)'}`,
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'var(--surface)')}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold" style={{ color: 'var(--text)' }}>
                  {g.icon && <span className="mr-1.5">{g.icon}</span>}
                  {g.name}
                </span>
                <Badge text={g.source} color={g.source === 'manual' ? 'blue' : g.source === 'compose' ? 'green' : 'yellow'} />
              </div>
              {g.description && (
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{g.description}</p>
              )}
              <div className="mt-3 flex items-center gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span>
                  <span className={g.running_count === g.member_count ? 'text-emerald-500' : 'text-red-500'} style={{ fontWeight: 600 }}>
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
