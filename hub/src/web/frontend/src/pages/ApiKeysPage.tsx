import { useState, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { ApiKey } from '@/types/api';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { timeAgo } from '@/lib/formatters';

export function ApiKeysPage() {
  const { isAuthenticated, token } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: keys } = useQuery({
    queryKey: ['api-keys'],
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
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch { /* error */ }
    setCreating(false);
  };

  const revoke = useCallback(async (id: number) => {
    if (!confirm('Revoke this API key? Any scripts using it will stop working.')) return;
    await apiAuth('DELETE', `/api-keys/${id}`, undefined, token);
    queryClient.invalidateQueries({ queryKey: ['api-keys'] });
  }, [token, queryClient]);

  const keyCols = useMemo(() => [
    { header: 'Name', accessor: (r: ApiKey) => r.name },
    { header: 'Key', accessor: (r: ApiKey) => <code className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.key_prefix}...</code> },
    { header: 'Created', accessor: (r: ApiKey) => timeAgo(r.created_at) },
    { header: 'Last Used', accessor: (r: ApiKey) => r.last_used_at ? timeAgo(r.last_used_at) : <span style={{ color: 'var(--text-muted)' }}>never</span> },
    { header: '', accessor: (r: ApiKey) => (
      <button onClick={() => revoke(r.id)} className="text-xs text-red-400 hover:text-red-300">
        Revoke
      </button>
    )},
  ], [revoke]);

  if (!isAuthenticated) {
    return (
      <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Log in to manage API keys.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>API Keys</h1>

      {/* Create form */}
      <Card title="Create API Key">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Key name (e.g., monitoring-script)"
            className="flex-1 rounded-lg px-3 py-2 text-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
            onKeyDown={e => e.key === 'Enter' && create()}
          />
          <button onClick={create} disabled={creating || !name.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>

        {newKey && (
          <div className="mt-3 rounded-lg p-3" style={{ backgroundColor: 'rgba(16,185,129,0.1)', border: '1px solid var(--color-success)' }}>
            <div className="mb-1 text-xs font-semibold" style={{ color: 'var(--color-success)' }}>
              Save this key — you won't see it again
            </div>
            <code className="block break-all rounded px-2 py-1 text-sm" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }}>
              {newKey}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(newKey).catch(() => {}); }}
              className="mt-2 rounded px-2 py-1 text-xs font-medium"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
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

      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Use API keys to authenticate scripts and automation. Include the key in the Authorization header:
        <code className="ml-1" style={{ color: 'var(--text-secondary)' }}>Authorization: Bearer insightd_...</code>
      </div>
    </div>
  );
}
