import { Badge } from '@/components/Badge';
import type { ExplainSummary } from '@/types/api';

const CONFIDENCE_COLOR: Record<NonNullable<ExplainSummary['confidence']>, string> = {
  high: 'green',
  medium: 'yellow',
  low: 'gray',
};

export function ReasonSummary({ summary }: { summary: ExplainSummary }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-fg">{summary.lead}</h4>
        {summary.confidence && (
          <Badge text={`${summary.confidence} confidence`} color={CONFIDENCE_COLOR[summary.confidence]} />
        )}
      </div>
      {summary.reasons.length > 0 && (
        <ol className="space-y-1 pl-1">
          {summary.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-secondary">
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg text-[10px] font-semibold tabular-nums text-muted">
                {i + 1}
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
