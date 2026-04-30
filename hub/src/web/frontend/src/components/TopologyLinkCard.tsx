import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';

interface Props {
  /** Cluster id (host_group_override > host_group > "cluster-{hostId}"). */
  clusterId: string;
  /** Namespaces to surface as topology links. Empty array → renders nothing. */
  namespaces: string[];
  /** Optional intro line. */
  description?: string;
}

/**
 * Compact entry point card for the Explore drawer that links to the
 * namespace topology view. On host detail pages we list every namespace
 * present on the node; on container detail pages we render a single
 * namespace (the one the container belongs to).
 */
export function TopologyLinkCard({ clusterId, namespaces, description }: Props) {
  if (namespaces.length === 0) return null;
  const single = namespaces.length === 1;
  return (
    <Card title="Cluster topology">
      {description && <p className="mb-2 text-xs text-muted">{description}</p>}
      <ul className="space-y-1">
        {namespaces.map(ns => (
          <li key={ns}>
            <Link
              to={`/clusters/${encodeURIComponent(clusterId)}/namespaces/${encodeURIComponent(ns)}/topology`}
              className="flex items-center justify-between gap-2 rounded border border-border bg-bg-secondary/40 px-2 py-1.5 text-sm text-fg hover:border-info/40 hover:bg-info/5"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">ns</span>
                <span className="truncate font-mono">{ns}</span>
              </span>
              <span className="shrink-0 text-[11px] text-info">{single ? 'View topology →' : '→'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
