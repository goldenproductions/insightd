import { useState, useMemo } from 'react';

interface Props {
  message: string;
  stream: 'stdout' | 'stderr';
  timestamp?: string;
  highlightPattern?: RegExp | null;
}

export function JsonLogLine({ message, stream, timestamp, highlightPattern }: Props) {
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(() => {
    try {
      const trimmed = message.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        return JSON.parse(trimmed) as unknown;
      }
    } catch { /* not JSON */ }
    return null;
  }, [message]);

  const isJson = parsed !== null;
  const stderrClass = stream === 'stderr' ? 'text-red-400' : '';

  if (!isJson) {
    return (
      <div className={stderrClass}>
        {timestamp && <span className="text-slate-500">{timestamp.slice(11, 23)} </span>}
        {highlightPattern ? highlightText(message, highlightPattern) : message}
      </div>
    );
  }

  const summary = getJsonSummary(parsed);

  return (
    <div className={stderrClass}>
      {timestamp && <span className="text-slate-500">{timestamp.slice(11, 23)} </span>}
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-white/10"
      >
        <span className="text-slate-500">{expanded ? '▼' : '▶'}</span>
        {!expanded && (
          <span>
            <span className="text-blue-400">{'{'}</span>
            <span className="text-slate-400"> {summary} </span>
            <span className="text-blue-400">{'}'}</span>
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-4 rounded border border-slate-700 bg-slate-900/50 p-2">
          <div className="mb-1 flex justify-end">
            <button
              onClick={() => navigator.clipboard.writeText(JSON.stringify(parsed, null, 2))}
              className="rounded px-1.5 py-0.5 text-xs text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
            >
              Copy
            </button>
          </div>
          <SyntaxColoredJson value={parsed} />
        </div>
      )}
    </div>
  );
}

function getJsonSummary(obj: unknown): string {
  if (typeof obj !== 'object' || obj === null) return String(obj);
  const entries = Object.entries(obj as Record<string, unknown>);
  const preview = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === 'string' ? `"${v.length > 20 ? v.slice(0, 20) + '...' : v}"` : String(v);
    return `${k}: ${val}`;
  }).join(', ');
  return entries.length > 3 ? `${preview}, ...` : preview;
}

function SyntaxColoredJson({ value, indent = 0 }: { value: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  if (value === null) return <span className="text-gray-500">null</span>;
  if (typeof value === 'boolean') return <span className="text-purple-400">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-amber-400">{value}</span>;
  if (typeof value === 'string') return <span className="text-emerald-400">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">[]</span>;
    return (
      <span>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {padInner}<SyntaxColoredJson value={item} indent={indent + 1} />
            {i < value.length - 1 ? ',' : ''}{'\n'}
          </span>
        ))}
        {pad}{']'}
      </span>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-slate-400">{'{}'}</span>;
    return (
      <span>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {padInner}<span className="text-blue-400">"{k}"</span>: <SyntaxColoredJson value={v} indent={indent + 1} />
            {i < entries.length - 1 ? ',' : ''}{'\n'}
          </span>
        ))}
        {pad}{'}'}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

function highlightText(text: string, pattern: RegExp): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let match: RegExpExecArray | null;

  while ((match = globalPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <mark key={match.index} className="rounded-sm bg-amber-500/30 text-inherit">{match[0]}</mark>
    );
    lastIndex = globalPattern.lastIndex;
    if (match[0]!.length === 0) globalPattern.lastIndex++;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? <>{parts}</> : text;
}

export { highlightText };
