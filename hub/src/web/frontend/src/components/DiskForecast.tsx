import type { DiskForecastItem } from '@/types/api';

export function DiskForecast({ forecasts }: { forecasts: DiskForecastItem[] }) {
  return (
    <div className="space-y-1.5 text-xs text-secondary">
      {forecasts.map(f => {
        let text: string;
        let colorClass: string;
        if (f.daysUntilFull != null && f.daysUntilFull < 14) {
          text = `${f.mountPoint}: ~${f.daysUntilFull}d until full (+${f.dailyGrowthGb}GB/day)`;
          colorClass = 'text-danger';
        } else if (f.daysUntilFull != null && f.daysUntilFull < 90) {
          text = `${f.mountPoint}: ~${f.daysUntilFull}d until full (+${f.dailyGrowthGb}GB/day)`;
          colorClass = 'text-warning';
        } else if (f.dailyGrowthGb > 0) {
          text = `${f.mountPoint}: Stable (+${f.dailyGrowthGb}GB/day)`;
          colorClass = 'text-success';
        } else {
          text = `${f.mountPoint}: Stable`;
          colorClass = 'text-muted';
        }
        return <div key={f.mountPoint} className={colorClass}>{text}</div>;
      })}
    </div>
  );
}
