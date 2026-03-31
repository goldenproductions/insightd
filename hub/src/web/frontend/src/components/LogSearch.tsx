interface Props {
  value: string;
  onChange: (value: string) => void;
  matchCount: number;
  mode: 'filter' | 'highlight';
  onModeChange: (mode: 'filter' | 'highlight') => void;
  isValid: boolean;
}

export function LogSearch({ value, onChange, matchCount, mode, onModeChange, isValid }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1" style={{ minWidth: '180px' }}>
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500">
          <SearchIcon />
        </span>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Search logs (regex)..."
          className={`w-full rounded-lg py-1.5 pl-8 pr-8 text-xs font-mono outline-none ${
            value && !isValid ? 'ring-1 ring-red-500' : ''
          }`}
          style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0' }}
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            ✕
          </button>
        )}
      </div>

      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden text-xs" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
        <button
          onClick={() => onModeChange('filter')}
          className={`px-2.5 py-1.5 transition-colors ${mode === 'filter' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Filter
        </button>
        <button
          onClick={() => onModeChange('highlight')}
          className={`px-2.5 py-1.5 transition-colors ${mode === 'highlight' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Highlight
        </button>
      </div>

      {/* Match count */}
      {value && isValid && (
        <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
          {matchCount} match{matchCount !== 1 ? 'es' : ''}
        </span>
      )}

      {value && !isValid && (
        <span className="text-xs text-red-400">Invalid regex</span>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}
