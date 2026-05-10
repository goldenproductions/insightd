// Single dynamic-import entry for chart code. InsightsPage.tsx lazy-loads it
// so recharts only enters the bundle when an insight is expanded.

import type { ExplainChart } from '@/types/api';
import { Sparkline } from './charts/Sparkline';
import { WeekOverlay } from './charts/WeekOverlay';
import { Forecast } from './charts/Forecast';
import { UptimeBars } from './charts/UptimeBars';

export default function InsightChart({ chart }: { chart: ExplainChart }) {
  switch (chart.kind) {
    case 'sparkline':    return <Sparkline   chart={chart} />;
    case 'week_overlay': return <WeekOverlay chart={chart} />;
    case 'forecast':     return <Forecast    chart={chart} />;
    case 'uptime_bars':  return <UptimeBars  chart={chart} />;
  }
}
