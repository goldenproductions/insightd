import { memo } from 'react';

export const DiskBar = memo(function DiskBar({ percent }: { percent: number }) {
  const color = percent >= 90 ? 'var(--color-danger)' : percent >= 85 ? 'var(--color-warning)' : 'var(--color-success)';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full" style={{ backgroundColor: 'var(--border)' }}>
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-medium" style={{ color }}>{percent}%</span>
    </div>
  );
});
