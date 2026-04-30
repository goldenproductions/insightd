import { useEffect, useRef, useState } from 'react';

interface Props {
  namespaces: string[];
  hidden: Set<string>;
  onToggle: (ns: string) => void;
  onShowAll: () => void;
}

/**
 * Compact multi-select dropdown for filtering containers by namespace.
 * Lives in the Uptime card actions row alongside the Advanced view toggle.
 * Closes on outside click + Escape.
 */
export function NamespaceFilterDropdown({ namespaces, hidden, onToggle, onShowAll }: Props) {
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
              <label
                key={ns}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg hover:bg-bg-secondary"
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => onToggle(ns)}
                  className="h-3.5 w-3.5 cursor-pointer accent-info"
                />
                <span className="truncate">{ns}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
