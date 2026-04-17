import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Finding, Neighbor } from '@/types/api';
import { timeAgo } from '@/lib/formatters';
import { DiagnosisCard, severityStyles } from '@/components/DiagnosisCard';
import { Button } from '@/components/FormField';
import { splitContainerEntityId } from '@/lib/containers';

export interface LiveSnapshot {
  status?: string | null;
  healthStatus?: string | null;
  cpuPercent?: number | null;
  memoryMb?: number | null;
}

export interface FindingPrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Optional native title attribute — typically used for a shortcut hint. */
  title?: string;
}

export interface FindingFeedbackCallbacks {
  onHelpful: () => void;
  onNotHelpful: () => void;
  /** Current vote state — drives button styling. */
  current: 'helpful' | 'unhelpful' | null;
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
  /**
   * Optional feedback callbacks. When provided, renders thumbs-up/down
   * buttons in the card footer that feed into Phase 4 confidence
   * calibration via the insight-feedback endpoint.
   */
  feedback?: FindingFeedbackCallbacks;
}

const CONFIDENCE_STYLES: Record<Finding['confidence'], string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-muted/20 text-muted',
};

// Pill classes for the PPR edge-type badges next to each neighbor.
const EDGE_STYLES: Record<string, string> = {
  same_host: 'bg-muted/20 text-muted',
  same_compose: 'bg-info/10 text-info',
  same_group: 'bg-info/10 text-info',
  metric_corr: 'bg-warning/10 text-warning',
};

function formatCpu(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v * 10) / 10}%`;
}

function formatMem(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${Math.round(v)} MB`;
}

function neighborLink(entityId: string): string {
  const split = splitContainerEntityId(entityId);
  if (split) {
    return `/hosts/${encodeURIComponent(split.hostId)}/containers/${encodeURIComponent(split.containerName)}`;
  }
  return `/hosts/${encodeURIComponent(entityId)}`;
}

function neighborLabel(entityId: string): string {
  return splitContainerEntityId(entityId)?.containerName ?? entityId;
}

export function FindingCard({ finding, technicalDetails, liveSnapshot, primaryAction, feedback }: Props) {
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const styles = severityStyles(finding.severity);

  // Filter out "ppr_root" from the chip row — it's rendered as a dedicated
  // Related services block below so users can click neighbors.
  const rankedChips = (finding.evidenceRanked ?? []).filter((e) => e.kind !== 'ppr_root');

  // Evidence visible by default — the single most common complaint from the
  // v26 audit was that the "good stuff" was hidden behind an expander.
  const EVIDENCE_VISIBLE_DEFAULT = 6;
  const visibleEvidence = showAllEvidence
    ? finding.evidence
    : finding.evidence.slice(0, EVIDENCE_VISIBLE_DEFAULT);
  const hiddenCount = Math.max(0, finding.evidence.length - EVIDENCE_VISIBLE_DEFAULT);

  const neighbors: Neighbor[] = finding.neighbors ?? [];

  const hasLive = liveSnapshot && (
    liveSnapshot.status != null ||
    liveSnapshot.healthStatus != null ||
    liveSnapshot.cpuPercent != null ||
    liveSnapshot.memoryMb != null
  );

  const pills = (
    <>
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${styles.bg} ${styles.text}`}
        title="critical = act now · warning = investigate · info = heads-up"
      >
        {finding.severity}
      </span>
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLES[finding.confidence]}`}
        title="Phase 4 calibrated posterior. Updates as you give feedback."
      >
        {finding.confidence} confidence
      </span>
    </>
  );

  const footer = (
    <div className="flex items-center justify-between gap-2">
      {finding.diagnosedAt && (
        <span title={finding.diagnosedAt}>Analysis updated {timeAgo(finding.diagnosedAt)}</span>
      )}
      {feedback && (
        <div className="flex items-center gap-1" role="group" aria-label="Was this diagnosis helpful?">
          <button
            onClick={feedback.onHelpful}
            className={`rounded p-1 text-sm transition-colors ${feedback.current === 'helpful' ? 'bg-success/20 text-success' : 'text-muted hover:bg-muted/10 hover:text-fg'}`}
            title="Helpful — record a positive calibration vote"
            aria-pressed={feedback.current === 'helpful'}
          >
            👍
          </button>
          <button
            onClick={feedback.onNotHelpful}
            className={`rounded p-1 text-sm transition-colors ${feedback.current === 'unhelpful' ? 'bg-danger/20 text-danger' : 'text-muted hover:bg-muted/10 hover:text-fg'}`}
            title="Not helpful — record a negative calibration vote"
            aria-pressed={feedback.current === 'unhelpful'}
          >
            👎
          </button>
        </div>
      )}
    </div>
  );

  return (
    <DiagnosisCard
      icon="🩺"
      severity={finding.severity}
      title={finding.conclusion}
      pills={pills}
      footer={footer}
    >
      {/* Signal chips: short semantic labels (e.g. "Zombie listener", "OOM risk")
          with severity coloring. Only show when there's more than one signal
          contributing — a single-signal finding is just the title restated. */}
      {rankedChips.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {rankedChips.map((chip, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${styles.bg} ${styles.text}`}
              title={`${chip.kind} — surprise ${chip.surprise}, explains ${Math.round(chip.explanatoryPower * 100)}%`}
            >
              {chip.label}
              <span className="tabular-nums opacity-70">{Math.round(chip.explanatoryPower * 100)}%</span>
            </span>
          ))}
        </div>
      )}

      {/* Evidence list — visible by default. The stable, bucketed values live
          here; anything "live" moves to the expander at the bottom. */}
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

      {/* Related services — PPR neighbors as clickable links. Replaces the
          old inline "Correlated with: X (same_host)" text buried in evidence.
          Shape comes from Finding.neighbors which is camelCase and carries
          an edgeTypes[] array (a pair can share multiple edge types — e.g.
          same_host AND metric_corr). Primary type drives the pill color. */}
      {neighbors.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Related services</div>
          <ul className="flex flex-wrap gap-2 text-xs">
            {neighbors.map((n, i) => {
              const primaryType = n.edgeTypes[0] ?? 'same_host';
              return (
                <li key={i}>
                  <Link
                    to={neighborLink(n.entityId)}
                    className="inline-flex items-center gap-1 rounded border border-muted/30 bg-bg-secondary px-2 py-0.5 text-fg hover:bg-muted/20 transition-colors"
                    title={`${n.entityId} — PPR score ${n.score}, edge types: ${n.edgeTypes.join(', ')}`}
                  >
                    <span>{neighborLabel(n.entityId)}</span>
                    <span className={`rounded-full px-1 text-[9px] ${EDGE_STYLES[primaryType] ?? 'bg-muted/20 text-muted'}`}>
                      {primaryType.replace('_', ' ')}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
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
                title={primaryAction.title}
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
