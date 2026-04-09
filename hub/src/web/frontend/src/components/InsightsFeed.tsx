import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { LinkButton } from '@/components/FormField';

export interface DashboardInsight {
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
}

const CATEGORY_CONFIG: Record<string, { icon: string; color: string; border: string }> = {
  prediction: { icon: '\ud83d\udd2e', color: 'text-danger', border: 'border-l-danger' },
  performance: { icon: '\u26a1', color: 'text-warning', border: 'border-l-warning' },
  trend: { icon: '\ud83d\udcc8', color: 'text-info', border: 'border-l-info' },
  availability: { icon: '\u23f0', color: 'text-danger', border: 'border-l-danger' },
};

function entityLink(insight: DashboardInsight): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    if (parts.length === 2) {
      return `/hosts/${encodeURIComponent(parts[0]!)}/containers/${encodeURIComponent(parts[1]!)}`;
    }
  }
  return `/hosts/${encodeURIComponent(insight.entity_id)}`;
}

function entityName(insight: DashboardInsight): string {
  if (insight.entity_type === 'container') {
    const parts = insight.entity_id.split('/');
    return parts.length === 2 ? parts[1]! : insight.entity_id;
  }
  return insight.entity_id;
}

export function InsightsFeed({ insights }: { insights: DashboardInsight[] }) {
  const filtered = insights.filter(i => i.severity !== 'info');

  if (filtered.length === 0) return null;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">Insights</h3>
        <LinkButton to="/insights" variant="ghost" size="sm">View all</LinkButton>
      </div>
      <div className="space-y-2">
        {filtered.map((insight, i) => {
          const config = CATEGORY_CONFIG[insight.category] ?? CATEGORY_CONFIG.performance!;
          return (
            <Link key={i} to={entityLink(insight)}
              className={`block rounded-lg border-l-[3px] ${config.border} bg-bg-secondary p-3 transition-colors hover:bg-surface-hover`}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 text-base leading-none">{config.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${config.color}`}>{insight.title}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                      insight.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
                    }`}>
                      {insight.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-secondary">{insight.message}</p>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                    <span className="capitalize">{insight.category}</span>
                    <span>&middot;</span>
                    <span>{entityName(insight)}</span>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
