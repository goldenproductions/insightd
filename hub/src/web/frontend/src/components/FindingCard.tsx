import { useState } from 'react';
import type { Finding } from '@/types/api';
import { timeAgo } from '@/lib/formatters';
import { DiagnosisCard, severityStyles } from '@/components/DiagnosisCard';
import { Button } from '@/components/FormField';

export interface LiveSnapshot {
  status?: string | null;
  healthStatus?: string | null;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  restartCount?: number | null;
}

export interface FindingPrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  finding: Finding;
  /** Optional raw technical details to show in an expandable section (e.g. Docker health check output) */
  technicalDetails?: string | null;
  /**
   * Live snapshot values for the "Current signals" expander. When provided,
   * users can crack it open to see the exact current metrics alongside the
   * stable diagnosis text above.
   */
  liveSnapshot?: LiveSnapshot;
  /**
   * Optional inline CTA rendered directly under the suggested action text.
   * Lets the page bind a concrete action (e.g. "Restart container") to the
   * diagnosis so the user doesn't have to hunt for the button elsewhere.
   */
  primaryAction?: FindingPrimaryAction;
}

const CONFIDENCE_STYLES: Record<Finding['confidence'], string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-muted/20 text-muted',
};

function formatCpu(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 10) / 10}%`;
}

function formatMem(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v)} MB`;
}

export function FindingCard({ finding, technicalDetails, liveSnapshot, primaryAction }: Props) {
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const styles = severityStyles(finding.severity);

  const TOP_EVIDENCE = 4;
  const visibleEvidence = showAllEvidence ? finding.evidence : finding.evidence.slice(0, TOP_EVIDENCE);
  const hiddenCount = Math.max(0, finding.evidence.length - TOP_EVIDENCE);

  const hasLive = liveSnapshot && (
    liveSnapshot.status != null ||
    liveSnapshot.healthStatus != null ||
    liveSnapshot.cpuPercent != null ||
    liveSnapshot.memoryMb != null ||
    liveSnapshot.restartCount != null
  );

  const pills = (
    <>
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${styles.bg} ${styles.text}`}>
        {finding.severity}
      </span>
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLES[finding.confidence]}`}>
        {finding.confidence} confidence
      </span>
    </>
  );

  const footer = finding.diagnosedAt ? (
    <span title={finding.diagnosedAt}>Analysis updated {timeAgo(finding.diagnosedAt)}</span>
  ) : undefined;

  return (
    <DiagnosisCard
      icon="🩺"
      severity={finding.severity}
      title={finding.conclusion}
      pills={pills}
      footer={footer}
    >
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

      {/* Suggested action + inline primary CTA */}
      {finding.suggestedAction && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Suggested action</div>
          <p className="text-xs leading-relaxed text-fg">{finding.suggestedAction}</p>
          {primaryAction && (
            <div className="mt-2">
              <Button
                variant="primary"
                size="sm"
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
              >
                {primaryAction.label}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Current signals expander — the evidence above is stable and bucketed,
          so power users who want the exact live values can crack this open. */}
      {hasLive && (
        <div>
          <button
            onClick={() => setShowLive(v => !v)}
            className="text-[11px] text-muted hover:text-fg transition-colors"
          >
            {showLive ? '▾' : '▸'} Current signals
          </button>
          {showLive && (
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-bg-secondary p-2 text-[11px] text-fg">
              {liveSnapshot!.status != null && (
                <><span className="text-muted">Status</span><span>{liveSnapshot!.status}</span></>
              )}
              {liveSnapshot!.healthStatus != null && (
                <><span className="text-muted">Health</span><span>{liveSnapshot!.healthStatus}</span></>
              )}
              {liveSnapshot!.cpuPercent != null && (
                <><span className="text-muted">CPU (now)</span><span>{formatCpu(liveSnapshot!.cpuPercent)}</span></>
              )}
              {liveSnapshot!.memoryMb != null && (
                <><span className="text-muted">Memory (now)</span><span>{formatMem(liveSnapshot!.memoryMb)}</span></>
              )}
              {liveSnapshot!.restartCount != null && (
                <><span className="text-muted">Restart count</span><span>{liveSnapshot!.restartCount}</span></>
              )}
            </div>
          )}
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
    </DiagnosisCard>
  );
}
