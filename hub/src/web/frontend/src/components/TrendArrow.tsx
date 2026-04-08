import { memo } from 'react';

export const TrendArrow = memo(function TrendArrow({ change }: { change: number | null }) {
  if (change == null) return <span className="text-muted">-</span>;
  if (change > 0) return <span className="font-medium text-danger">+{change}%</span>;
  if (change < 0) return <span className="font-medium text-success">{change}%</span>;
  return <span className="text-muted">0%</span>;
});
