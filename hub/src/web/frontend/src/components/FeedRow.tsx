import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { timeAgo } from '@/lib/formatters';

export type FeedSeverity = 'critical' | 'warning' | 'info';

export interface FeedRowProps {
  icon: string;
  title: string;
  pillLabel: string;
  severity: FeedSeverity;
  detail?: string;
  meta: string;
  time?: string | null;
  to: string;
  footer?: ReactNode;
}

const BORDER_CLASS: Record<FeedSeverity, string> = {
  critical: 'border-l-danger',
  warning: 'border-l-warning',
  info: 'border-l-info',
};

const TITLE_CLASS: Record<FeedSeverity, string> = {
  critical: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

const PILL_CLASS: Record<FeedSeverity, string> = {
  critical: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
};

export function FeedRow({ icon, title, pillLabel, severity, detail, meta, time, to, footer }: FeedRowProps) {
  return (
    <div className={`rounded-lg border-l-[3px] ${BORDER_CLASS[severity]} bg-bg-secondary`}>
      <Link to={to} className="block p-3 transition-colors hover:bg-surface-hover">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-base leading-none">{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium ${TITLE_CLASS[severity]}`}>{title}</span>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium uppercase ${PILL_CLASS[severity]}`}>
                {pillLabel}
              </span>
            </div>
            {detail && <p className="mt-1 text-sm leading-relaxed text-secondary">{detail}</p>}
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <span>{meta}</span>
              {time && (
                <>
                  <span>&middot;</span>
                  <span>{timeAgo(time)}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
      {footer}
    </div>
  );
}
