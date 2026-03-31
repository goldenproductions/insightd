import { useState, useMemo, useRef, useEffect } from 'react';
import { api } from '@/lib/api';
import type { LogResponse, LogLine } from '@/types/api';
import { Select, Button } from './FormField';
import { LogSearch } from './LogSearch';
import { JsonLogLine } from './JsonLogLine';

interface Props {
  hostId: string;
  containerName: string;
  compact?: boolean;
}

export function LogViewer({ hostId, containerName, compact }: Props) {
  const [stream, setStream] = useState('both');
  const [lines, setLines] = useState('100');
  const [logs, setLogs] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchValue, setSearchValue] = useState('');
  const [searchMode, setSearchMode] = useState<'filter' | 'highlight'>('highlight');

  const logEndRef = useRef<HTMLDivElement>(null);

  const regex = useMemo(() => {
    if (!searchValue) return null;
    try {
      return new RegExp(searchValue, 'gi');
    } catch {
      return null;
    }
  }, [searchValue]);

  const isValidRegex = !searchValue || regex !== null;

  const filteredLogs = useMemo(() => {
    if (!logs?.logs) return [];
    if (!searchValue || !regex) return logs.logs;
    if (searchMode === 'filter') {
      return logs.logs.filter(l => regex.test(l.message));
    }
    return logs.logs;
  }, [logs, searchValue, regex, searchMode]);

  const matchCount = useMemo(() => {
    if (!logs?.logs || !regex) return 0;
    return logs.logs.filter(l => regex.test(l.message)).length;
  }, [logs, regex]);

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

  useEffect(() => {
    if (logs && logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [logs, filteredLogs]);

  return (
    <div className="space-y-3">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={stream} onChange={e => setStream(e.target.value)} className="!w-auto"
          style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0' }}>
          <option value="both">All streams</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
        </Select>
        {!compact && (
          <input
            type="number"
            value={lines}
            onChange={e => setLines(e.target.value)}
            min="1"
            max="1000"
            className="w-20 rounded-lg px-3 py-2 text-sm"
            style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0' }}
          />
        )}
        <Button onClick={loadLogs} disabled={loading}>
          {loading ? 'Loading...' : logs ? 'Refresh' : 'Load Logs'}
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Search bar (only show after logs are loaded) */}
      {logs && logs.logs && logs.logs.length > 0 && (
        <LogSearch
          value={searchValue}
          onChange={setSearchValue}
          matchCount={matchCount}
          mode={searchMode}
          onModeChange={setSearchMode}
          isValid={isValidRegex}
        />
      )}

      {/* Log output */}
      {logs && (
        <div
          ref={logEndRef}
          className={`overflow-auto rounded-lg p-3 font-mono text-xs leading-relaxed ${compact ? 'max-h-64' : 'max-h-96'}`}
          style={{ backgroundColor: '#0f172a', color: '#e2e8f0' }}
        >
          {filteredLogs.length > 0
            ? filteredLogs.map((l: LogLine, i: number) => (
                <JsonLogLine
                  key={i}
                  message={l.message}
                  stream={l.stream}
                  timestamp={l.timestamp}
                  highlightPattern={searchMode === 'highlight' ? regex : null}
                />
              ))
            : <span className="text-slate-500">
                {searchValue && logs.logs && logs.logs.length > 0 ? 'No matching lines' : 'No logs available'}
              </span>
          }
        </div>
      )}
    </div>
  );
}
