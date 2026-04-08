import { useState, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import type { ApiKey } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/FormField';
import { timeAgo } from '@/lib/formatters';
import { PageTitle } from '@/components/PageTitle';
import { EmptyState } from '@/components/EmptyState';

export function ApiKeysPage() {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: keys } = useQuery({
    queryKey: queryKeys.apiKeys(),
    queryFn: () => api<ApiKey[]>('/api-keys'),
    enabled: isAuthenticated,
  });

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await apiAuth('POST', '/api-keys', { name: name.trim() }, token) as { key: string };
      setNewKey(res.key);
      setName('');
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
    } catch { /* error */ }
    setCreating(false);
  };

  const revoke = useCallback(async (id: number) => {
    if (!confirm('Revoke this API key? Any scripts using it will stop working.')) return;
    await apiAuth('DELETE', `/api-keys/${id}`, undefined, token);
    queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
  }, [token, queryClient]);

  const keyCols = useMemo(() => [
    { header: 'Name', accessor: (r: ApiKey) => r.name },
    { header: 'Key', accessor: (r: ApiKey) => <code className="text-xs text-muted">{r.key_prefix}...</code> },
    { header: 'Created', accessor: (r: ApiKey) => timeAgo(r.created_at) },
    { header: 'Last Used', accessor: (r: ApiKey) => r.last_used_at ? timeAgo(r.last_used_at) : <span className="text-muted">never</span> },
    { header: '', accessor: (r: ApiKey) => (
      <button onClick={() => revoke(r.id)} className="text-xs text-danger hover:text-danger">
        Revoke
      </button>
    )},
  ], [revoke]);

  if (!isAuthenticated) {
    return <EmptyState message="Log in to manage API keys." />;
  }

  return (
    <div className="space-y-6">
      <PageTitle>API Keys</PageTitle>

      {/* Create form */}
      <Card title="Create API Key">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Key name (e.g., monitoring-script)"
            className="flex-1 rounded-lg px-3 py-2 text-sm bg-bg-secondary border border-border text-fg"
            onKeyDown={e => e.key === 'Enter' && create()}
          />
          <Button variant="primary" onClick={create} disabled={creating || !name.trim()}>
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </div>

        {newKey && (
          <div className="mt-3 rounded-lg p-3 bg-success/10 border border-success">
            <div className="mb-1 text-xs font-semibold text-success">
              Save this key — you won't see it again
            </div>
            <code className="block break-all rounded px-2 py-1 text-sm bg-bg-secondary text-fg">
              {newKey}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(newKey).catch(() => {}); }}
              className="mt-2 rounded px-2 py-1 text-xs font-medium bg-surface border border-border text-secondary"
            >
              Copy to clipboard
            </button>
          </div>
        )}
      </Card>

      {/* Keys list */}
      <Card title="Active Keys">
        <DataTable
          columns={keyCols}
          data={keys || []}
          emptyText="No API keys created yet"
        />
      </Card>

      <div className="text-xs text-muted">
        Use API keys to authenticate scripts and automation. Include the key in the Authorization header:
        <code className="ml-1 text-secondary">Authorization: Bearer insightd_...</code>
      </div>
    </div>
  );
}
