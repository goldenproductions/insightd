interface Insight {
  entity_type: string;
  entity_id: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
}

const severityConfig = {
  critical: { icon: '\u26a0\ufe0f', color: 'var(--color-danger)', bg: 'rgba(239,68,68,0.1)' },
  warning: { icon: '\u26a1', color: 'var(--color-warning)', bg: 'rgba(245,158,11,0.1)' },
  info: { icon: '\u2139\ufe0f', color: 'var(--color-info)', bg: 'rgba(59,130,246,0.1)' },
};

export function InsightsFeed({ insights }: { insights: Insight[] }) {
  if (!insights || insights.length === 0) {
    return <p className="py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No insights — everything looks normal</p>;
  }

  return (
    <div className="space-y-2">
      {insights.map((insight, i) => {
        const config = severityConfig[insight.severity] || severityConfig.info;
        return (
          <div key={i} className="flex items-start gap-3 rounded-lg p-3" style={{ backgroundColor: config.bg }}>
            <span className="mt-0.5 text-sm">{config.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium" style={{ color: config.color }}>{insight.title}</div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{insight.message}</div>
            </div>
            <span className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--bg-secondary)' }}>
              {insight.category}
            </span>
          </div>
        );
      })}
    </div>
  );
}
