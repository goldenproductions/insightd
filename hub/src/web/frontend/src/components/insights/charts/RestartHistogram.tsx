import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function RestartHistogram({ chart }: { chart: ExplainChart }) {
  if (chart.points.length === 0) {
    return <div className="text-xs text-muted">No restarts in this window.</div>;
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <BarChart data={chart.points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="value" fill="var(--color-warning)" name="Restarts" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
