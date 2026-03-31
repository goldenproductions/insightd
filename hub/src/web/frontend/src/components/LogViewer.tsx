import { useState } from 'react';
import { api } from '@/lib/api';
import type { LogResponse } from '@/types/api';
import { Select, Button } from './FormField';

export function LogViewer({ hostId, containerName }: { hostId: string; containerName: string }) {
  const [stream, setStream] = useState('both');
  const [lines, setLines] = useState('100');
  const [logs, setLogs] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<LogResponse>(
        `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}/logs?lines=${lines}&stream=${stream}`
      );
      setLogs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={stream} onChange={e => setStream(e.target.value)} className="!w-auto">
          <option value="both">All streams</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
        </Select>
        <input
          type="number"
          value={lines}
          onChange={e => setLines(e.target.value)}
          min="1"
          max="1000"
          className="w-20 rounded-lg px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <Button onClick={loadLogs} disabled={loading}>
          {loading ? 'Loading...' : logs ? 'Refresh' : 'Load Logs'}
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {logs && (
        <pre
          className="max-h-96 overflow-auto rounded-lg p-3 font-mono text-xs leading-relaxed"
          style={{ backgroundColor: '#0f172a', color: '#e2e8f0' }}
        >
          {logs.logs && logs.logs.length > 0
            ? logs.logs.map((l, i) => (
                <div key={i} className={l.stream === 'stderr' ? 'text-red-400' : ''}>
                  {l.timestamp && <span className="text-slate-500">{l.timestamp.slice(11, 23)} </span>}
                  {l.message}
                </div>
              ))
            : <span className="text-slate-500">No logs available</span>
          }
        </pre>
      )}
    </div>
  );
}
