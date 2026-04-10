import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/FormField';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { queryKeys } from '@/lib/queryKeys';
import type { ImageUpdate } from '@/types/api';

interface ImageUpdatesCardProps {
  imageUpdates: ImageUpdate[] | undefined;
}

export function ImageUpdatesCard({ imageUpdates }: ImageUpdatesCardProps) {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleCheck() {
    setChecking(true);
    setResult(null);
    try {
      const res = await apiAuth<{ ok: boolean; hostsNotified: number }>('POST', '/image-updates/check', undefined, token);
      setResult(`Checking ${res.hostsNotified} host${res.hostsNotified !== 1 ? 's' : ''}...`);
      // Refetch after a delay to pick up results
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.imageUpdates() });
        setResult(null);
        setChecking(false);
      }, 15000);
    } catch {
      setResult('Failed to trigger check');
      setChecking(false);
    }
  }

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
      {isAuthenticated && (
        <div className="mt-4 flex items-center gap-3">
          <Button size="sm" onClick={handleCheck} disabled={checking}>
            {checking ? 'Checking...' : 'Check for updates'}
          </Button>
          {result && <span className="text-xs text-muted">{result}</span>}
        </div>
      )}
    </Card>
  );
}
