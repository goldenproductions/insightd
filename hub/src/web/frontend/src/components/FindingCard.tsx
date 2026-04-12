import { useState } from 'react';
import type { Finding } from '@/types/api';

interface Props {
  finding: Finding;
  /** Optional raw technical details to show in an expandable section (e.g. Docker health check output) */
  technicalDetails?: string | null;
}

const SEVERITY_STYLES: Record<Finding['severity'], { border: string; bg: string; text: string }> = {
  critical: { border: 'border-l-danger', bg: 'bg-danger/10', text: 'text-danger' },
  warning: { border: 'border-l-warning', bg: 'bg-warning/10', text: 'text-warning' },
  info: { border: 'border-l-info', bg: 'bg-info/10', text: 'text-info' },
};

const CONFIDENCE_STYLES: Record<Finding['confidence'], string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-muted/20 text-muted',
};

export function FindingCard({ finding, technicalDetails }: Props) {
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const styles = SEVERITY_STYLES[finding.severity];

  const TOP_EVIDENCE = 4;
  const visibleEvidence = showAllEvidence ? finding.evidence : finding.evidence.slice(0, TOP_EVIDENCE);
  const hiddenCount = Math.max(0, finding.evidence.length - TOP_EVIDENCE);

  return (
    <div className={`rounded-lg border border-border border-l-[3px] ${styles.border} ${styles.bg} p-4 space-y-3`}>
      {/* Header: icon + conclusion + pills */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-base leading-none" aria-hidden>🩺</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-2">
            <span className={`text-sm font-semibold ${styles.text}`}>{finding.conclusion}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${styles.bg} ${styles.text}`}>
              {finding.severity}
            </span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLES[finding.confidence]}`}>
              {finding.confidence} confidence
            </span>
          </div>
        </div>
      </div>

      {/* Evidence list */}
      {finding.evidence.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">What we observed</div>
          <ul className="space-y-1 text-xs text-fg">
            {visibleEvidence.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted mt-0.5">•</span>
                <span className="flex-1">{e}</span>
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAllEvidence(v => !v)}
              className="mt-1 text-[11px] text-muted hover:text-fg transition-colors"
            >
              {showAllEvidence ? 'Show fewer' : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}

      {/* Suggested action */}
      {finding.suggestedAction && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Suggested action</div>
          <p className="text-xs leading-relaxed text-fg">{finding.suggestedAction}</p>
        </div>
      )}

      {/* Technical details expander */}
      {technicalDetails && (
        <div>
          <button
            onClick={() => setShowTechnical(v => !v)}
            className="text-[11px] text-muted hover:text-fg transition-colors"
          >
            {showTechnical ? '▾' : '▸'} Technical details
          </button>
          {showTechnical && (
            <pre className="mt-1 rounded bg-bg-secondary p-2 text-[11px] text-muted font-mono whitespace-pre-wrap break-all">
              {technicalDetails}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
