import { memo } from 'react';
import type { NodeCondition } from '@/types/api';
import { timeAgo } from '@/lib/formatters';

const colorForCondition = (c: NodeCondition): 'red' | 'yellow' => {
  if (c.type === 'Ready') return c.status === 'Unknown' ? 'yellow' : 'red';
  if (c.type === 'NetworkUnavailable') return c.status === 'True' ? 'red' : 'yellow';
  return 'red';
};

const isUnhealthy = (c: NodeCondition): boolean => {
  if (c.type === 'Ready') return c.status !== 'True';
  return c.status === 'True';
};

const badgeStyles: Record<'red' | 'yellow', string> = {
  red: 'bg-red-500/10 text-red-600 dark:text-red-400',
  yellow: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export const NodeConditionBadges = memo(function NodeConditionBadges({ conditions }: { conditions: NodeCondition[] }) {
  const unhealthy = conditions.filter(isUnhealthy);
  if (unhealthy.length === 0) return null;
  return (
    <>
      {unhealthy.map(c => {
        const color = colorForCondition(c);
        const since = c.last_transition_at ? timeAgo(c.last_transition_at) : null;
        const tooltip = [
          `${c.type}=${c.status}`,
          since ? `since ${since}` : null,
          c.reason ? `— ${c.reason}` : null,
          c.message ? `: ${c.message}` : null,
        ].filter(Boolean).join(' ');
        return (
          <span
            key={c.type}
            title={tooltip}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyles[color]}`}
          >
            {c.type === 'Ready' ? 'NotReady' : c.type}
          </span>
        );
      })}
    </>
  );
});
