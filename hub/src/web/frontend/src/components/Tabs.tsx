interface Tab {
  id: string;
  label: string;
  count?: number;
  /** Optional keyboard shortcut hint, shown on hover as "<label> (<shortcut>)" */
  shortcut?: string;
}

export function Tabs({ tabs, active, onChange }: { tabs: Tab[]; active: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {tabs.map(tab => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            id={`tab-${tab.id}`}
            title={tab.shortcut ? `${tab.label} (${tab.shortcut})` : undefined}
            onClick={() => onChange(tab.id)}
            className={`relative px-4 py-2 text-sm font-medium transition-colors ${isActive ? 'text-info' : 'text-muted'} ${!isActive ? 'hover-text-secondary' : ''}`}
            style={{ marginBottom: '-1px' }}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-1.5 rounded-full bg-bg-secondary px-1.5 py-0.5 text-xs text-muted">
                {tab.count}
              </span>
            )}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-info" />
            )}
          </button>
        );
      })}
    </div>
  );
}
