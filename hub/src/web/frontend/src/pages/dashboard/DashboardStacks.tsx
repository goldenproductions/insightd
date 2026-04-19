import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { LinkButton } from '@/components/FormField';
import type { ServiceGroupSummary } from '@/types/api';

export function DashboardStacks({ groups }: { groups: ServiceGroupSummary[] }) {
  if (groups.length === 0) return null;

  return (
    <Card
      title="Stacks"
      actions={<LinkButton to="/stacks" variant="ghost" size="sm">Manage</LinkButton>}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groups.slice(0, 6).map(g => {
          const ok = g.running_count === g.member_count;
          return (
            <Link
              key={g.id}
              to={`/stacks/${g.id}`}
              className="block rounded-lg border border-border bg-surface p-3 card-interactive"
              style={{ borderLeft: `3px solid ${g.color || 'var(--color-info)'}` }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-fg">
                  {g.icon && <span className="mr-1">{g.icon}</span>}
                  {g.name}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                  {ok ? 'healthy' : 'degraded'}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric label="Running" value={`${g.running_count}/${g.member_count}`} />
                <Metric label="CPU" value={g.total_cpu != null ? `${Math.round(g.total_cpu)}%` : '—'} />
                <Metric label="Mem" value={g.total_memory != null ? `${Math.round(g.total_memory)}` : '—'} />
              </div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-bold tabular-nums text-fg">{value}</div>
    </div>
  );
}
