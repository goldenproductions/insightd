import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import type { ImageUpdate } from '@/types/api';

interface ImageUpdatesCardProps {
  imageUpdates: ImageUpdate[] | undefined;
}

export function ImageUpdatesCard({ imageUpdates }: ImageUpdatesCardProps) {
  return (
    <Card title="Container Image Updates">
      {(!imageUpdates || imageUpdates.length === 0) ? (
        <p className="text-sm text-muted">All container images are up to date.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {imageUpdates.length} container{imageUpdates.length > 1 ? 's' : ''} with newer images on Docker Hub.
          </p>
          <div className="space-y-2">
            {imageUpdates.map(u => (
              <Link key={`${u.host_id}/${u.container_name}`}
                to={`/hosts/${encodeURIComponent(u.host_id)}/containers/${encodeURIComponent(u.container_name)}`}
                className="flex items-center justify-between rounded-lg p-3 hover-border-info card-interactive bg-bg-secondary border border-border"
              >
                <div>
                  <div className="text-sm font-medium text-fg">{u.container_name}</div>
                  <div className="mt-0.5 text-xs text-muted">{u.image}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge text={u.host_id} color="blue" />
                  <Badge text="Update available" color="yellow" />
                </div>
              </Link>
            ))}
          </div>
          <p className="text-xs text-muted">
            Checked {imageUpdates[0]?.checked_at ? new Date(imageUpdates[0].checked_at + 'Z').toLocaleString() : 'recently'}
          </p>
        </div>
      )}
    </Card>
  );
}
