interface Props {
  namespaces: string[];
  hidden: Set<string>;
  onToggle: (ns: string) => void;
  onShowAll: () => void;
  totalCount: number;
  visibleCount: number;
}

export function NamespaceFilterBar({ namespaces, hidden, onToggle, onShowAll, totalCount, visibleCount }: Props) {
  if (namespaces.length === 0) return null;

  const hasFilter = hidden.size > 0;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3">
      <span className="text-xs font-medium text-muted">Namespaces</span>
      {namespaces.map(ns => {
        const isHidden = hidden.has(ns);
        return (
          <button
            key={ns}
            type="button"
            onClick={() => onToggle(ns)}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              isHidden
                ? 'bg-gray-500/10 text-muted line-through opacity-60 hover:opacity-80'
                : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20'
            }`}
          >
            {ns}
          </button>
        );
      })}
      {hasFilter && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-1 text-xs text-muted underline decoration-dotted hover:text-fg"
        >
          Show all ({totalCount - visibleCount} hidden)
        </button>
      )}
    </div>
  );
}
