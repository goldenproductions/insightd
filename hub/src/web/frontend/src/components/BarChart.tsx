import { memo } from 'react';

interface Props {
  values: number[];
  colorFn?: (value: number) => string;
  maxLabel?: string;
  minLabel?: string;
  height?: number;
}

const defaultColorFn = (v: number) =>
  v > 90 ? 'var(--color-danger)' : v > 70 ? 'var(--color-warning)' : 'var(--color-success)';

export const BarChart = memo(function BarChart({ values, colorFn = defaultColorFn, maxLabel, minLabel, height = 44 }: Props) {
  if (values.length < 2) return null;

  const maxVal = Math.max(...values, 1);
  const barCount = Math.min(values.length, 60);
  const step = Math.max(1, Math.floor(values.length / barCount));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push(values[i]!);
  }

  return (
    <div>
      <div className="flex items-end gap-px" style={{ height }}>
        {sampled.map((v, i) => {
          const h = Math.max(2, Math.round((v / maxVal) * height));
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm transition-all"
              style={{ height: h, backgroundColor: colorFn(v), minWidth: 2 }}
              title={String(v)}
            />
          );
        })}
      </div>
      {(minLabel || maxLabel) && (
        <div className="mt-1 flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{minLabel || ''}</span>
          <span>{maxLabel || ''}</span>
        </div>
      )}
    </div>
  );
});
