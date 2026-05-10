import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from 'recharts';
import type { ExplainChart } from '@/types/api';

export function Forecast({ chart }: { chart: ExplainChart }) {
  type Row = { ts: string; history?: number; mid?: number; cone?: [number, number] };
  const rows: Row[] = [];
  for (const p of chart.points) rows.push({ ts: p.ts, history: p.value });
  for (const f of chart.forecast ?? []) {
    rows.push({ ts: f.ts, mid: f.mid, cone: [f.lower, f.upper] });
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} unit={chart.yLabel} />
          <Tooltip />
          <Area type="monotone" dataKey="cone" stroke="none" fill="var(--color-info)" fillOpacity={0.15} />
          <Line type="monotone" dataKey="history" stroke="var(--color-info)"    dot={false} strokeWidth={2} name="History" />
          <Line type="monotone" dataKey="mid"     stroke="var(--color-warning)" dot={false} strokeDasharray="4 4" name="Forecast" />
          {chart.threshold != null && (
            <ReferenceLine y={chart.threshold} stroke="var(--color-danger)" strokeDasharray="4 4"
              label={{ value: chart.thresholdLabel ?? 'Threshold', fill: 'var(--color-danger)', fontSize: 10, position: 'right' }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
