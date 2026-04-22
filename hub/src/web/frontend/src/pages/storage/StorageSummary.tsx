import { memo } from 'react';
import type { DisksOverview } from '@/types/api';

function fmtGb(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return (gb * 1024).toFixed(0) + ' MB';
}

interface Props {
  totals: DisksOverview['totals'];
  mountCount: number;
  hostCount: number;
}

export const StorageSummary = memo(function StorageSummary({ totals, mountCount, hostCount }: Props) {
  const pct = totals.usedPercent;
  const barColor = pct >= 90 ? 'var(--color-danger)' : pct >= 85 ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <div className="rounded-xl border border-border bg-surface p-4 lg:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Fleet storage</h2>
        <span className="text-xs text-muted">{mountCount} mount{mountCount === 1 ? '' : 's'} across {hostCount} host{hostCount === 1 ? '' : 's'}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-5">
        <Stat label="Total" value={fmtGb(totals.totalGb)} />
        <Stat label="Used" value={fmtGb(totals.usedGb)} accent={pct >= 85 ? 'warn' : undefined} />
        <Stat label="Free" value={fmtGb(totals.freeGb)} />
      </div>

      <div className="mt-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-xs">
          <span className="text-muted">{pct}% used</span>
          <span className="tabular-nums text-muted">{fmtGb(totals.usedGb)} / {fmtGb(totals.totalGb)}</span>
        </div>
      </div>
    </div>
  );
});

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'warn' }) {
  const color = accent === 'warn' ? 'text-warning' : 'text-fg';
  return (
    <div>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}
