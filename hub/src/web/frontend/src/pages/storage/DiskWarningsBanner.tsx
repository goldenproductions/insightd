import { useState } from 'react';
import type { DiskOverviewWarning } from '@/types/api';

interface Props {
  warnings: DiskOverviewWarning[];
  onSelectHost: (hostId: string) => void;
}

export function DiskWarningsBanner({ warnings, onSelectHost }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;

  const critical = warnings.filter(w => w.severity === 'critical');
  const hasCritical = critical.length > 0;
  const tone = hasCritical ? 'danger' : 'warning';

  const borderColor = tone === 'danger' ? 'border-l-danger' : 'border-l-warning';
  const textColor = tone === 'danger' ? 'text-danger' : 'text-warning';
  const countColor = tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning';

  const headline = hasCritical
    ? `${critical.length} critical, ${warnings.length - critical.length} warning`
    : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;

  const topLimit = 3;
  const shown = expanded ? warnings : warnings.slice(0, topLimit);

  return (
    <div className={`rounded-xl border border-border border-l-4 ${borderColor} bg-surface p-4`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${countColor}`}>{headline}</span>
          <span className="text-sm font-medium text-fg">Disks need attention</span>
        </div>
        {warnings.length > topLimit && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-muted transition-colors hover:text-fg"
          >
            {expanded ? 'Show less' : `Show all ${warnings.length}`}
          </button>
        )}
      </div>

      <ul className="mt-3 space-y-1.5 text-sm">
        {shown.map(w => (
          <li key={`${w.hostId}:${w.mountPoint}`}>
            <button
              type="button"
              onClick={() => onSelectHost(w.hostId)}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left transition-colors hover:bg-bg-secondary"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${w.severity === 'critical' ? 'bg-danger' : 'bg-warning'}`} />
                <span className="truncate font-medium text-fg">{w.hostId}</span>
                <span className="truncate text-muted">{w.mountPoint}</span>
              </span>
              <span className={`shrink-0 text-xs tabular-nums ${textColor}`}>
                {warningMessage(w)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function warningMessage(w: DiskOverviewWarning): string {
  if (w.reason === 'forecast' && w.daysUntilFull != null) {
    return `${w.usedPercent}% · ~${w.daysUntilFull}d until full`;
  }
  return `${w.usedPercent}% used`;
}
