import { Link } from 'react-router-dom';
import type { DashboardData } from '@/types/api';

function StatusItem({ label, value, color, to }: { label: string; value: React.ReactNode; color?: string; to?: string }) {
  const inner = (
    <span className="text-sm">
      <span className="text-muted">{label}</span>{' '}
      <span className="font-semibold" style={{ color: color || 'var(--text)' }}>{value}</span>
    </span>
  );
  if (to) return <Link to={to} className="transition-opacity hover:opacity-80">{inner}</Link>;
  return inner;
}

function Dot() {
  return <span className="text-xs text-muted">&middot;</span>;
}

export function StatusRow({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-xl px-4 py-3 bg-surface border border-border">
      <StatusItem label="Hosts" value={`${data.hostsOnline}/${data.hostCount}`} to="/hosts"
        color={data.hostsOffline > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
      <Dot />
      <StatusItem label="Containers" value={`${data.containersRunning}/${data.totalContainers}`} to="/hosts"
        color={data.containersDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
      <Dot />
      <StatusItem label="Alerts" value={data.activeAlerts} to="/alerts"
        color={data.activeAlerts > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
      <Dot />
      <StatusItem label="Disk warnings" value={data.diskWarnings} to="/hosts"
        color={data.diskWarnings > 0 ? 'var(--color-warning)' : 'var(--color-success)'} />
      <Dot />
      <StatusItem label="Updates" value={data.updatesAvailable} to="/updates"
        color={data.updatesAvailable > 0 ? 'var(--color-info)' : undefined} />
      {data.endpointsTotal > 0 && (
        <>
          <Dot />
          <StatusItem label="Endpoints" value={`${data.endpointsUp}/${data.endpointsTotal}`} to="/endpoints"
            color={data.endpointsDown > 0 ? 'var(--color-danger)' : 'var(--color-success)'} />
        </>
      )}
    </div>
  );
}
