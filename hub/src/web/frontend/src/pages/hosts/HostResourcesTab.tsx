import type { HostDetail, Trends, ContainerTrend, DiskSnapshot, UpdateCheck } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { DiskBar } from '@/components/DiskBar';
import { DiskForecast } from '@/components/DiskForecast';
import { TrendArrow } from '@/components/TrendArrow';
import { EmptyState } from '@/components/EmptyState';
import { fmtPercent } from '@/lib/formatters';

const trendsCols: Column<ContainerTrend>[] = [
  { header: 'Container', accessor: r => r.name },
  { header: 'CPU Avg', accessor: r => fmtPercent(r.cpuNow) },
  { header: 'CPU Change', accessor: r => <TrendArrow change={r.cpuChange} /> },
  { header: 'Mem Avg', accessor: r => r.memNow != null ? `${r.memNow} MB` : '-' },
  { header: 'Mem Change', accessor: r => <TrendArrow change={r.memChange} /> },
];

const diskCols: Column<DiskSnapshot>[] = [
  { header: 'Mount', accessor: r => r.mount_point },
  { header: 'Usage', accessor: r => `${r.used_gb}/${r.total_gb} GB` },
  { header: 'Percent', accessor: r => <DiskBar percent={r.used_percent} /> },
];

const updatesCols: Column<UpdateCheck>[] = [
  { header: 'Container', accessor: r => r.container_name },
  { header: 'Image', accessor: r => r.image },
];

interface Props {
  data: HostDetail;
  trends: Trends | undefined;
}

export function HostResourcesTab({ data, trends }: Props) {
  return (
    <div className="space-y-6">
      {trends && trends.containers.length > 0 && (
        <Card title="Trends (vs last week)">
          <DataTable
            columns={trendsCols}
            data={trends.containers}
          />
        </Card>
      )}

      {data.disk.length > 0 && (
        <Card title="Disk Usage">
          <DataTable
            columns={diskCols}
            data={data.disk}
          />
          {data.diskForecast && <div className="mt-3"><DiskForecast forecasts={data.diskForecast} /></div>}
        </Card>
      )}

      {data.updates.length > 0 && (
        <Card title="Updates Available">
          <DataTable
            columns={updatesCols}
            data={data.updates}
          />
        </Card>
      )}

      {(!trends || trends.containers.length === 0) && data.disk.length === 0 && data.updates.length === 0 && (
        <EmptyState message="No resource data available" />
      )}
    </div>
  );
}
