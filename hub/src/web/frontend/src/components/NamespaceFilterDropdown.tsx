import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  namespaces: string[];
  hidden: Set<string>;
  onToggle: (ns: string) => void;
  onShowAll: () => void;
  /** When provided, each namespace row gets a "→ Topology" link to the
   *  namespace topology page. Omit on hosts that aren't in a k8s cluster. */
  clusterId?: string | null;
}

/**
 * Compact multi-select dropdown for filtering containers by namespace.
 * Lives in the Uptime card actions row alongside the Advanced view toggle.
 * Closes on outside click + Escape.
 */
export function NamespaceFilterDropdown({ namespaces, hidden, onToggle, onShowAll, clusterId }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (namespaces.length === 0) return null;

  const visibleCount = namespaces.length - hidden.size;
  const hasFilter = hidden.size > 0;
  const summary = hasFilter
    ? `${visibleCount}/${namespaces.length}`
    : 'All';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors ${
          hasFilter
            ? 'border-info/40 bg-info/5 text-info hover:bg-info/10'
            : 'border-border bg-surface text-secondary hover:bg-surface-hover hover:text-fg'
        }`}
        title="Filter containers by namespace"
      >
        <span>Namespaces: {summary}</span>
        <span className="text-[9px]" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute right-0 z-20 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between border-b border-border px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Show</span>
            {hasFilter && (
              <button
                type="button"
                onClick={onShowAll}
                className="text-[11px] text-info hover:underline"
              >
                Select all
              </button>
            )}
          </div>
          {namespaces.map(ns => {
            const isVisible = !hidden.has(ns);
            return (
              <div
                key={ns}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-fg hover:bg-bg-secondary"
              >
                <label className="flex cursor-pointer items-center gap-2 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={() => onToggle(ns)}
                    className="h-3.5 w-3.5 cursor-pointer accent-info"
                  />
                  <span className="truncate">{ns}</span>
                </label>
                {clusterId && (
                  <Link
                    to={`/clusters/${encodeURIComponent(clusterId)}/namespaces/${encodeURIComponent(ns)}/topology`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info/10"
                    title={`Open topology for ${ns}`}
                    onClick={() => setOpen(false)}
                  >
                    Topology →
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
