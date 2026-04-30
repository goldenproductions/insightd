import type { PodCondition } from '@/types/api';

interface Props {
  /** JSON-stringified PodCondition[] from container_snapshots.pod_conditions. */
  conditionsJson: string | null;
}

const STANDARD_ORDER = ['PodScheduled', 'Initialized', 'ContainersReady', 'Ready'];

/**
 * Inline badges for k8s pod conditions. Renders one pill per condition that
 * is *not* True — when the pod is fully healthy the component renders
 * nothing, keeping the hero calm. When something is degraded (e.g.
 * Ready=False during a rolling restart, or PodScheduled=False on a stuck
 * pod), the offending conditions surface as warning/danger pills with the
 * reason on hover.
 *
 * Returns null on parse failure or empty data — safe to mount unconditionally.
 */
export function PodConditionsBadges({ conditionsJson }: Props) {
  const conditions = parse(conditionsJson);
  if (conditions.length === 0) return null;

  // Highlight only the ones that aren't currently True. Sort by standard order
  // so the badges read in the same sequence k8s reports them.
  const flagged = conditions
    .filter(c => c.status !== 'True')
    .sort((a, b) => orderOf(a.type) - orderOf(b.type));

  if (flagged.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {flagged.map(c => {
        const tone = c.status === 'False'
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-muted/40 bg-muted/10 text-muted';
        const tip = c.reason
          ? (c.message ? `${c.reason}: ${c.message}` : c.reason)
          : `${c.type}=${c.status}`;
        return (
          <span
            key={c.type}
            title={tip}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
          >
            {c.type}={c.status}
          </span>
        );
      })}
    </span>
  );
}

function parse(raw: string | null): PodCondition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is PodCondition =>
      c && typeof c === 'object' && typeof c.type === 'string' && typeof c.status === 'string',
    );
  } catch {
    return [];
  }
}

function orderOf(type: string): number {
  const i = STANDARD_ORDER.indexOf(type);
  return i < 0 ? STANDARD_ORDER.length : i;
}
