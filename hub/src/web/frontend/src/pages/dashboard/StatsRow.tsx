import type { DashboardData } from '@/types/api';
import { HeroStatCard, type PillColor } from './HeroStatCard';

function availabilityPill(pct: number | null): { text: string; color: PillColor } | undefined {
  if (pct == null) return undefined;
  if (pct >= 99.5) return { text: '💚 Thriving', color: 'green' };
  if (pct >= 99) return { text: '💛 Coping', color: 'yellow' };
  if (pct >= 95) return { text: '🧡 Struggling', color: 'yellow' };
  return { text: '❤️ Life support', color: 'red' };
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function StatsRow({ data }: { data: DashboardData }) {
  const pct = data.availability.overallPercent;
  const uptimeValue = pct != null ? `${pct}%` : '—';
  const uptimePill = availabilityPill(pct);

  const activeAlerts = data.activeAlerts;
  const incidentsValue = activeAlerts;
  const incidentsPill: { text: string; color: PillColor } | undefined = activeAlerts > 0
    ? { text: `${activeAlerts} open`, color: 'red' }
    : { text: 'all clear', color: 'green' };

  const firstAlert = data.activeAlertsList[0];
  const incidentsSub = firstAlert
    ? <>{firstAlert.target} &middot; {formatRelative(firstAlert.triggered_at)}</>
    : 'No active incidents';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <HeroStatCard
        title="Uptime"
        value={uptimeValue}
        pill={uptimePill}
        sub={pct != null ? 'Last 24h' : 'No data yet'}
      />
      <HeroStatCard
        title="Incidents"
        value={incidentsValue}
        pill={incidentsPill}
        sub={incidentsSub}
        to={activeAlerts > 0 ? '/alerts' : undefined}
      />
    </div>
  );
}
