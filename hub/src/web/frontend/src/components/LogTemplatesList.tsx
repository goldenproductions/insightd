import { useState } from 'react';
import type { LogTemplate } from '@/types/api';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { timeAgo } from '@/lib/formatters';

interface Props {
  templates?: LogTemplate[];
}

// Keep in sync with SEMANTIC_RULES in hub/src/insights/diagnosis/templateClassifier.ts.
// Frontend doesn't have access to the backend module so we duplicate the
// tag→label map here. Unknown tags fall through as capitalized raw strings.
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
  oom: 'red',
  panic: 'red',
  segfault: 'red',
  fatal: 'red',
  conn_refused: 'yellow',
  conn_reset: 'yellow',
  conn_timeout: 'yellow',
  dns_fail: 'yellow',
  disk_full: 'red',
  db_locked: 'yellow',
  http_502: 'red',
  http_503: 'red',
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function isRecent(timestamp: string, windowMs: number): boolean {
  const t = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
  return !isNaN(t) && Date.now() - t < windowMs;
}

/**
 * Drain-mined log templates for this container's image. Grouped by
 * occurrence count, with semantic tag badges and a "NEW" pill for
 * templates first-seen in the last 5 minutes.
 */
export function LogTemplatesList({ templates }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!templates || templates.length === 0) return null;

  const newTemplates = templates.filter((t) => isRecent(t.first_seen, 5 * 60_000));
  const summary = `${templates.length} log pattern${templates.length === 1 ? '' : 's'} mined`
    + (newTemplates.length > 0 ? ` · ${newTemplates.length} new` : '');

  return (
    <Card
      title="Known log patterns"
      actions={
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted hover:text-fg transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      }
    >
      <p className="text-xs text-muted">{summary} via Drain template mining on the 5-minute log cache window.</p>
      {expanded && (
        <ul className="mt-3 space-y-2">
          {templates.map((t) => (
            <li
              key={t.template_hash}
              className="rounded border border-border/50 bg-bg-secondary/50 p-2 text-xs"
            >
              <div className="flex items-start justify-between gap-3">
                <code className="flex-1 break-words font-mono text-[11px] text-fg">
                  {truncate(t.template, 240)}
                </code>
                <div className="flex shrink-0 items-center gap-1">
                  {isRecent(t.first_seen, 5 * 60_000) && (
                    <Badge text="NEW" color="blue" />
                  )}
                  {t.semantic_tag && (
                    <Badge
                      text={TAG_LABELS[t.semantic_tag] ?? t.semantic_tag}
                      color={TAG_COLORS[t.semantic_tag] ?? 'gray'}
                    />
                  )}
                  <span className="text-muted tabular-nums">×{t.occurrence_count}</span>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-muted">
                first seen <span title={t.first_seen}>{timeAgo(t.first_seen)}</span>
                {' · '}
                last seen <span title={t.last_seen}>{timeAgo(t.last_seen)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
