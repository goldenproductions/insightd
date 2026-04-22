import { useState, useEffect, useCallback } from 'react';
import type { DisksOverview } from '@/types/api';
import { StorageSummary } from './StorageSummary';
import { DiskWarningsBanner } from './DiskWarningsBanner';

const STORAGE_KEY = 'insightd-storage-overview-collapsed';

function readCollapsed(): boolean {
  // Default: collapsed. Only expand if the user has explicitly opened it.
  if (typeof window === 'undefined') return true;
  try { return window.localStorage.getItem(STORAGE_KEY) !== '0'; }
  catch { return true; }
}

function writeCollapsed(v: boolean): void {
  try { window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* quota, private mode */ }
}

interface Props {
  data: DisksOverview;
  mountCount: number;
  hostCount: number;
  onSelectHost: (hostId: string) => void;
}

export function StorageOverview({ data, mountCount, hostCount, onSelectHost }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  useEffect(() => { writeCollapsed(collapsed); }, [collapsed]);

  const toggle = useCallback(() => setCollapsed(c => !c), []);
  const warningCount = data.warnings.length;
  const criticalCount = data.warnings.filter(w => w.severity === 'critical').length;

  if (collapsed) {
    return (
      <CollapsedRow
        totals={data.totals}
        mountCount={mountCount}
        hostCount={hostCount}
        warningCount={warningCount}
        criticalCount={criticalCount}
        onExpand={toggle}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-wider text-muted">Overview</span>
        <button
          type="button"
          onClick={toggle}
          className="text-xs text-muted transition-colors hover:text-fg"
          aria-label="Collapse overview"
        >
          Hide ▲
        </button>
      </div>
      <StorageSummary totals={data.totals} mountCount={mountCount} hostCount={hostCount} />
      {data.warnings.length > 0 && (
        <DiskWarningsBanner warnings={data.warnings} onSelectHost={onSelectHost} />
      )}
    </div>
  );
}

function CollapsedRow({
  totals, mountCount, hostCount, warningCount, criticalCount, onExpand,
}: {
  totals: DisksOverview['totals'];
  mountCount: number;
  hostCount: number;
  warningCount: number;
  criticalCount: number;
  onExpand: () => void;
}) {
  const pct = totals.usedPercent;
  const pctTone = pct >= 90 ? 'text-danger' : pct >= 85 ? 'text-warning' : 'text-fg';
  const barColor = pct >= 90 ? 'var(--color-danger)' : pct >= 85 ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <button
      type="button"
      onClick={onExpand}
      className="group flex w-full items-center gap-4 rounded-xl border border-border bg-surface px-4 py-2.5 text-left transition-colors hover:bg-bg-secondary"
      aria-label="Expand overview"
    >
      <span className={`text-sm font-semibold tabular-nums ${pctTone}`}>{pct}%</span>

      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-border">
        <div className="h-full" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }} />
      </div>

      <span className="truncate text-xs text-muted">
        {fmtGb(totals.usedGb)} / {fmtGb(totals.totalGb)} used
        {' · '}
        {mountCount} mount{mountCount === 1 ? '' : 's'} across {hostCount} host{hostCount === 1 ? '' : 's'}
      </span>

      {warningCount > 0 && (
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
          criticalCount > 0 ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
        }`}>
          {criticalCount > 0
            ? `${criticalCount} critical${warningCount - criticalCount > 0 ? ` · ${warningCount - criticalCount} warning` : ''}`
            : `${warningCount} warning${warningCount === 1 ? '' : 's'}`}
        </span>
      )}

      <span className={`${warningCount > 0 ? '' : 'ml-auto'} shrink-0 text-xs text-muted transition-colors group-hover:text-fg`}>
        Show ▼
      </span>
    </button>
  );
}

function fmtGb(gb: number): string {
  if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return (gb * 1024).toFixed(0) + ' MB';
}
