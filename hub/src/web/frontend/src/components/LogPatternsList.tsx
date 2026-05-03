import { useState } from 'react';
import type { LogTemplate } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { GlossaryHelp } from '@/components/GlossaryHelp';
import { timeAgo } from '@/lib/formatters';

interface Props {
  templates?: LogTemplate[];
}

// Keep in sync with SEMANTIC_RULES in hub/src/insights/diagnosis/templateClassifier.ts.
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

function isRecent(timestamp: string, windowMs: number): boolean {
  const t = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
  return !isNaN(t) && Date.now() - t < windowMs;
}

function isSpiking(t: LogTemplate): boolean {
  return (t.spike_count ?? 0) > 0;
}

function PatternRow({ t }: { t: LogTemplate }) {
  const spiking = isSpiking(t);
  const newish = isRecent(t.first_seen, 5 * 60_000);

  return (
    <li
      className={
        'rounded border p-2 text-xs ' +
        (spiking
          ? 'border-l-2 border-l-warning border-warning/40 bg-warning/5'
          : 'border-border/50 bg-bg-secondary/50')
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <code className="min-w-0 flex-1 break-words font-mono text-[11px] text-fg">
          {truncate(t.template, 240)}
        </code>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {spiking && (
            <Badge
              text={(t.spike_count ?? 0) > 1 ? `Spiking ×${t.spike_count}` : 'Spiking'}
              color="yellow"
            />
          )}
          {newish && <Badge text="NEW" color="blue" />}
          {t.semantic_tag && (
            <Badge
              text={TAG_LABELS[t.semantic_tag] ?? t.semantic_tag}
              color={TAG_COLORS[t.semantic_tag] ?? 'gray'}
            />
          )}
          <span className="text-muted tabular-nums" title="Lifetime occurrence count across the image">
            ×{t.occurrence_count}
          </span>
        </div>
      </div>
      {spiking && t.latest_spike_ts && t.max_intensity != null ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] text-warning/80">
          <span className="min-w-0 break-words">
            last spike <span title={t.latest_spike_ts}>{timeAgo(t.latest_spike_ts)}</span>
            {t.latest_batch_count != null && <> · ×{t.latest_batch_count} in batch</>}
          </span>
          <span className="tabular-nums" title={`${formatIntensity(t.max_intensity)} historical baseline rate`}>
            max {formatIntensity(t.max_intensity)} baseline
          </span>
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-muted">
          first seen <span title={t.first_seen}>{timeAgo(t.first_seen)}</span>
          {' · '}
          last seen <span title={t.last_seen}>{timeAgo(t.last_seen)}</span>
        </div>
      )}
    </li>
  );
}

/**
 * Unified Drain-template surface for a container's Explore drawer. Each row
 * represents one template (image-wide); rows whose template fired
 * abnormally on this specific container in the last hour get a "Spiking"
 * annotation, a tinted left border, and an alternate meta line showing the
 * latest-spike intensity. Templates are pre-sorted by the backend with
 * spiking ones at the top.
 *
 * Replaces the previous separate "Known log patterns" + "Log spikes" cards
 * (the latter never shipped under that name — see #228 history).
 */
export function LogPatternsList({ templates }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!templates || templates.length === 0) return null;

  const spikeCount = templates.reduce((acc, t) => acc + (isSpiking(t) ? 1 : 0), 0);
  const summary = spikeCount > 0
    ? `${templates.length} log pattern${templates.length === 1 ? '' : 's'} mined · ${spikeCount} spiking now`
    : `${templates.length} log pattern${templates.length === 1 ? '' : 's'} mined`;

  return (
    <Card
      title={<>Log patterns<GlossaryHelp topic="log-patterns" /></>}
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
        {summary} via Drain template mining. Spiking patterns fired noticeably above their historical rate on this container in the last hour.
      </p>
      {expanded && (
        <ul className="mt-3 space-y-2">
          {templates.map((t) => <PatternRow key={t.template_hash} t={t} />)}
        </ul>
      )}
    </Card>
  );
}
