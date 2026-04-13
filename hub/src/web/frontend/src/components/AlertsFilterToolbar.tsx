export type TimeRange = '24h' | '7d' | '30d' | 'all';

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

interface Props {
  /** All host IDs that have at least one alert in the unfiltered set. */
  hosts: string[];
  /** Currently selected host filter, or null for "all hosts". */
  selectedHost: string | null;
  onHostChange: (host: string | null) => void;
  /** Currently selected time range filter (applies to resolved alerts only). */
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}

/**
 * Compact filter row above the alert tables. Two filters:
 * - Host (dropdown, "All hosts" + every host that has an alert)
 * - Time range (chips, applies only to the Resolved section)
 *
 * Active alerts are never time-filtered — they always need to surface
 * regardless of when they fired.
 */
export function AlertsFilterToolbar({ hosts, selectedHost, onHostChange, timeRange, onTimeRangeChange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted">Host</span>
        <select
          value={selectedHost ?? ''}
          onChange={e => onHostChange(e.target.value || null)}
          className="rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-info"
        >
          <option value="">All hosts</option>
          {hosts.map(h => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <span className="text-muted" title="Time range applies to resolved alerts only. Active alerts always show regardless of age.">Resolved range</span>
        <div className="flex items-center gap-1">
          {TIME_RANGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onTimeRangeChange(opt.value)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                timeRange === opt.value
                  ? 'bg-info text-white'
                  : 'text-muted hover:bg-bg-secondary hover:text-fg'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
