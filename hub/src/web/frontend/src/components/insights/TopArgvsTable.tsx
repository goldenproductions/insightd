import type { ExplainTopArgvsBlock } from '@/types/api';

export function TopArgvsTable({ rows }: ExplainTopArgvsBlock) {
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="bg-bg-secondary px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        Top spawned processes (last 15 min)
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="px-3 py-1.5 text-left">Command</th>
            <th className="px-3 py-1.5 text-right">Spawns</th>
            <th className="px-3 py-1.5 text-right">Avg lifetime</th>
            <th className="px-3 py-1.5 text-left">Argv</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.argv_hash} className="border-t border-border">
              <td className="px-3 py-1.5 font-mono">{r.comm ?? '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.spawn_count}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{Math.round(r.avg_lifetime_ms)} ms</td>
              <td className="px-3 py-1.5 break-all font-mono text-xs">{r.argv}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
