import type { Analogy } from '@/lib/analogies';

interface Props<T> {
  items: T[];
  valueKey: keyof T;
  formatFn: (value: number) => string;
  analogyFn?: (value: number) => Analogy | null;
  nameKey?: keyof T;
  hostKey?: keyof T;
}

export function RankingList<T extends object>({ items, valueKey, formatFn, analogyFn, nameKey = 'container_name' as keyof T, hostKey = 'host_id' as keyof T }: Props<T>) {
  if (!items || items.length === 0) {
    return <p className="py-4 text-center text-xs text-muted">No ranking data yet.</p>;
  }

  const max = Math.max(...items.map(r => (r[valueKey] as number) || 0), 1);

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const value = (item[valueKey] as number) || 0;
        const pct = Math.round((value / max) * 100);
        return (
          <div key={i}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg">
                {String(item[nameKey])}
                <span className="ml-1 text-muted">{String(item[hostKey])}</span>
              </span>
              <span className="font-medium text-secondary">
                {formatFn(value)}
                {analogyFn && (() => { const a = analogyFn(value); return a ? <span className="ml-1 text-[10px] text-muted">{a.emoji}</span> : null; })()}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-border">
              <div className="h-1.5 rounded-full bg-info transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
