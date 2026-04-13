import type { ReactNode } from 'react';

export type DiagnosisSeverity = 'critical' | 'warning' | 'info';

const SEVERITY_STYLES: Record<DiagnosisSeverity, { border: string; bg: string; text: string }> = {
  critical: { border: 'border-l-danger', bg: 'bg-danger/10', text: 'text-danger' },
  warning: { border: 'border-l-warning', bg: 'bg-warning/10', text: 'text-warning' },
  info: { border: 'border-l-info', bg: 'bg-info/10', text: 'text-info' },
};

export function severityStyles(severity: DiagnosisSeverity) {
  return SEVERITY_STYLES[severity];
}

interface Props {
  icon: string;
  severity: DiagnosisSeverity;
  title: string;
  /** Optional muted sub-line below the title (e.g. "Powered by Gemini — verify before acting") */
  subtitle?: string;
  /** Pills that sit inline with the title (severity, confidence, etc.) */
  pills?: ReactNode;
  /** Slot on the right of the header — typically a Button (e.g. "Re-run") */
  headerAction?: ReactNode;
  children: ReactNode;
  /** Muted footer row under a subtle divider (timestamps, caveats metadata) */
  footer?: ReactNode;
}

/**
 * Shared chrome for diagnosis-style cards. Both the rule-based FindingCard and
 * the AI-driven AIDiagnosisCard consume this so they share layout, spacing,
 * and severity styling without duplicating the wrapper markup.
 */
export function DiagnosisCard({ icon, severity, title, subtitle, pills, headerAction, children, footer }: Props) {
  const styles = SEVERITY_STYLES[severity];
  return (
    <div className={`rounded-lg border border-border border-l-[3px] ${styles.border} ${styles.bg} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="mt-0.5 text-base leading-none" aria-hidden>{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start gap-2">
              <span className={`text-sm font-semibold ${styles.text}`}>{title}</span>
              {pills}
            </div>
            {subtitle && <div className="mt-0.5 text-[11px] text-muted">{subtitle}</div>}
          </div>
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      {children}
      {footer && <div className="border-t border-border-light pt-2 text-[11px] text-muted">{footer}</div>}
    </div>
  );
}
