import type { DiskForecastItem } from '@/types/api';

export function DiskForecast({ forecasts }: { forecasts: DiskForecastItem[] }) {
  return (
    <div className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
      {forecasts.map(f => {
        let text: string;
        let color: string;
        if (f.daysUntilFull != null && f.daysUntilFull < 14) {
          text = `${f.mountPoint}: ~${f.daysUntilFull}d until full (+${f.dailyGrowthGb}GB/day)`;
          color = 'var(--color-danger)';
        } else if (f.daysUntilFull != null && f.daysUntilFull < 90) {
          text = `${f.mountPoint}: ~${f.daysUntilFull}d until full (+${f.dailyGrowthGb}GB/day)`;
          color = 'var(--color-warning)';
        } else if (f.dailyGrowthGb > 0) {
          text = `${f.mountPoint}: Stable (+${f.dailyGrowthGb}GB/day)`;
          color = 'var(--color-success)';
        } else {
          text = `${f.mountPoint}: Stable`;
          color = 'var(--text-muted)';
        }
        return <div key={f.mountPoint} style={{ color }}>{text}</div>;
      })}
    </div>
  );
}
