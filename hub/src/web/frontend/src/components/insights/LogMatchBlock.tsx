import type { ExplainLogMatchBlock } from '@/types/api';

export function LogMatchBlock(props: ExplainLogMatchBlock) {
  const { pattern_id, matched_line, context_before, context_after, captures, occurrences } = props;
  const captureRows = Object.entries(captures);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between bg-bg-secondary px-3 py-2 text-xs">
        <span className="font-medium uppercase tracking-wide text-muted">{pattern_id}</span>
        <span className="tabular-nums text-muted">{occurrences}× in last 24h</span>
      </div>
      <pre className="bg-bg px-3 py-2 text-xs overflow-x-auto font-mono whitespace-pre">
        {context_before.length > 0 && (
          <span className="text-muted">{context_before.join('\n')}{'\n'}</span>
        )}
        <span className="text-fg font-medium">{matched_line}</span>
        {context_after.length > 0 && (
          <span className="text-muted">{'\n'}{context_after.join('\n')}</span>
        )}
      </pre>
      {captureRows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left">Field</th>
              <th scope="col" className="px-3 py-1.5 text-left">Value</th>
            </tr>
          </thead>
          <tbody>
            {captureRows.map(([k, v]) => (
              <tr key={k} className="border-t border-border">
                <td className="px-3 py-1.5 font-mono">{k}</td>
                <td className="px-3 py-1.5 font-mono break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
