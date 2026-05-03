import { useState } from 'react';
import type { LogBurstEvent, LogBurstsResponse } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';

interface Props {
  data: LogBurstsResponse | undefined;
}

// Same map as LogTemplatesList — keep in sync with templateClassifier.ts.
const TAG_LABELS: Record<string, string> = {
  oom: 'Out of memory',
  panic: 'Panic',
  segfault: 'Segfault',
  fatal: 'Fatal',
  conn_refused: 'Conn refused',
  conn_reset: 'Conn reset',
  conn_timeout: 'Conn timeout',
  dns_fail: 'DNS failure',
  permission: 'Permission',
  disk_full: 'Disk full',
  too_many_files: 'Too many files',
  db_locked: 'DB locked',
  http_401: 'HTTP 401',
  http_403: 'HTTP 403',
  http_404: 'HTTP 404',
  http_502: 'HTTP 502',
  http_503: 'HTTP 503',
};

const TAG_COLORS: Record<string, string> = {
  oom: 'red', panic: 'red', segfault: 'red', fatal: 'red',
  conn_refused: 'yellow', conn_reset: 'yellow', conn_timeout: 'yellow',
  dns_fail: 'yellow', disk_full: 'red', db_locked: 'yellow',
  http_502: 'red', http_503: 'red',
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatIntensity(n: number): string {
  if (n >= 100) return `${Math.round(n)}×`;
  if (n >= 10) return `${n.toFixed(0)}×`;
  return `${n.toFixed(1)}×`;
}

function IntensityBar({ intensity }: { intensity: number }) {
  // Scale: 1× → 0% (matches baseline), 10× → 100% (decisive spike).
  // Clamp at 10× so a single huge outlier doesn't squash everything else.
  const pct = Math.max(0, Math.min(100, ((intensity - 1) / 9) * 100));
  const tone = intensity >= 5 ? 'bg-warning' : intensity >= 2.5 ? 'bg-info' : 'bg-fg/40';
  return (
    <div
      className="relative h-1 w-12 rounded bg-bg-secondary"
      title={`${formatIntensity(intensity)} historical baseline rate`}
    >
      <div className={`absolute inset-y-0 left-0 rounded ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function BurstRow({ b }: { b: LogBurstEvent }) {
  return (
    <li className="rounded border border-border/50 bg-bg-secondary/50 p-2 text-xs">
      <div className="flex items-start justify-between gap-3">
        <code className="flex-1 break-words font-mono text-[11px] text-fg">
          {truncate(b.template, 200)}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          {b.semantic_tag && (
            <Badge
              text={TAG_LABELS[b.semantic_tag] ?? b.semantic_tag}
              color={TAG_COLORS[b.semantic_tag] ?? 'gray'}
            />
          )}
          <span className="text-muted tabular-nums" title={`Batch fired ${b.batch_count} time(s)`}>
            ×{b.batch_count}
          </span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted">
        <span title={b.ts}>{timeAgo(b.ts)}</span>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">{formatIntensity(b.intensity)} baseline</span>
          <IntensityBar intensity={b.intensity} />
        </div>
      </div>
    </li>
  );
}

/**
 * Burst events from Drain template mining for this specific container, within
 * the time window. Complements `LogTemplatesList` (image-wide, lifetime
 * counts) by showing what spiked here, when. Empty when nothing has fired
 * abnormally — by design, calm-by-default.
 */
export function LogBurstsList({ data }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!data || data.bursts.length === 0) return null;

  const summary = `${data.bursts.length} log burst${data.bursts.length === 1 ? '' : 's'} in the last hour`;

  return (
    <Card
      title="Log bursts"
      actions={
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted hover:text-fg transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      }
    >
      <p className="text-xs text-muted">
        {summary} — templates that fired noticeably above their historical rate.
      </p>
      {expanded && (
        <ul className="mt-3 space-y-2">
          {data.bursts.map((b) => <BurstRow key={b.id} b={b} />)}
        </ul>
      )}
    </Card>
  );
}
