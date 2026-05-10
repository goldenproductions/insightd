import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function WeekOverlay({ chart }: { chart: ExplainChart }) {
  const SHIFT_MS = 7 * 24 * 60 * 60 * 1000;
  const compareShifted = (chart.compare ?? []).map(p => ({
    ts: new Date(new Date(p.ts.replace(' ', 'T') + 'Z').getTime() + SHIFT_MS).toISOString(),
    last: p.value,
  }));
  const byTs = new Map<string, { ts: string; current?: number; last?: number }>();
  for (const p of chart.points)        byTs.set(p.ts,  { ts: p.ts,  current: p.value });
  for (const p of compareShifted)      byTs.set(p.ts,  { ...(byTs.get(p.ts) ?? { ts: p.ts }), last: p.last });
  const data = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="current" stroke="var(--color-info)"  dot={false} strokeWidth={2} name="This week" />
          <Line type="monotone" dataKey="last"    stroke="var(--color-muted)" dot={false} strokeDasharray="4 4" name="Last week" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
