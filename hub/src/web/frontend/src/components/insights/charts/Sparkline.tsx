import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function Sparkline({ chart }: { chart: ExplainChart }) {
  if (chart.points.length === 0) {
    return <div className="text-xs text-muted">No metric history yet for this entity.</div>;
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={chart.points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="var(--color-info)" dot={false} strokeWidth={2} />
          {chart.threshold != null && (
            <ReferenceLine
              y={chart.threshold}
              stroke="var(--color-danger)"
              strokeDasharray="4 4"
              label={{ value: chart.thresholdLabel ?? 'Threshold', fill: 'var(--color-danger)', fontSize: 10, position: 'right' }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
