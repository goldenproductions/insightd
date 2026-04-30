import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { RcaNeighbor, RcaNeighborsResponse } from '@/types/api';
import { Card } from '@/components/Card';
import { GlossaryHelp } from '@/components/GlossaryHelp';

interface Props {
  data: RcaNeighborsResponse | undefined;
}

const EDGE_LABELS: Record<string, { label: string; tone: string; title: string }> = {
  same_host: {
    label: 'host',
    tone: 'border-border text-muted',
    title: 'Co-located on the same host',
  },
  same_compose: {
    label: 'compose',
    tone: 'border-info/40 text-info',
    title: 'Same docker-compose project label',
  },
  metric_corr: {
    label: 'corr',
    tone: 'border-warning/40 text-warning',
    title: 'CPU/memory correlation over the last 48h of hourly rollups',
  },
};

function EdgeChips({ types }: { types: string[] }) {
  return (
    <span className="flex gap-1">
      {types.map(t => {
        const meta = EDGE_LABELS[t] ?? { label: t, tone: 'border-border text-muted', title: t };
        return (
          <span
            key={t}
            title={meta.title}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${meta.tone}`}
          >
            {meta.label}
          </span>
        );
      })}
    </span>
  );
}

function HealthDot({ n }: { n: RcaNeighbor }) {
  // Active alert dominates; only fall back to health_status if no alert.
  if (n.hasActiveAlert) {
    return <span className="inline-block h-2 w-2 rounded-full bg-danger" title="Has active alert" />;
  }
  if (n.healthStatus === 'unhealthy') {
    return <span className="inline-block h-2 w-2 rounded-full bg-warning" title="Unhealthy" />;
  }
  if (n.healthStatus === 'starting') {
    return <span className="inline-block h-2 w-2 rounded-full bg-info" title="Starting" />;
  }
  if (n.isRemoved) {
    return <span className="inline-block h-2 w-2 rounded-full bg-muted/40" title="Removed" />;
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-success/60" title="Healthy" />;
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score * 100));
  return (
    <div className="relative h-1 w-12 rounded bg-bg-secondary" title={`Edge weight ${score.toFixed(2)}`}>
      <div className="absolute inset-y-0 left-0 rounded bg-fg/40" style={{ width: `${pct}%` }} />
    </div>
  );
}

function NeighborRow({ n }: { n: RcaNeighbor }) {
  const href = `/hosts/${encodeURIComponent(n.hostId)}/containers/${encodeURIComponent(n.containerName)}`;
  // Display name: prefer last path segment for k8s "ns/stable/container" so
  // the row stays readable in narrow drawers.
  const displayName = n.containerName.includes('/')
    ? n.containerName.split('/').pop()!
    : n.containerName;
  const tooltip = n.containerName !== displayName ? n.containerName : undefined;

  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-bg-secondary/50">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <HealthDot n={n} />
        {n.isRemoved ? (
          <span className="truncate text-sm text-muted line-through" title={tooltip ?? n.containerName}>
            {displayName}
          </span>
        ) : (
          <Link to={href} className="truncate text-sm text-fg hover:underline" title={tooltip ?? n.containerName}>
            {displayName}
          </Link>
        )}
        <span className="truncate text-xs text-muted">{n.hostId}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <EdgeChips types={n.edgeTypes} />
        <ScoreBar score={n.score} />
      </div>
    </li>
  );
}

/**
 * Top correlated neighbors of a container, derived from the rca_edges graph.
 * Default collapsed; users open the Explore drawer first, then expand.
 */
export function RcaNeighborsList({ data }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!data || data.neighbors.length === 0) return null;

  const summary = `${data.neighbors.length} correlated neighbor${data.neighbors.length === 1 ? '' : 's'}`;

  return (
    <Card
      title={<>RCA neighbors<GlossaryHelp topic="rca-neighbors" /></>}
      actions={
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-xs text-muted hover:text-fg transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      }
    >
      <p className="text-xs text-muted">{summary}</p>
      {expanded && (
        <ul className="mt-2 space-y-0.5">
          {data.neighbors.map(n => <NeighborRow key={n.entity} n={n} />)}
        </ul>
      )}
    </Card>
  );
}
