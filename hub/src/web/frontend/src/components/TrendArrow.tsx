import { memo } from 'react';

export const TrendArrow = memo(function TrendArrow({ change }: { change: number | null }) {
  if (change == null) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
  if (change > 0) return <span className="font-medium text-red-500">+{change}%</span>;
  if (change < 0) return <span className="font-medium text-emerald-500">{change}%</span>;
  return <span style={{ color: 'var(--text-muted)' }}>0%</span>;
});
