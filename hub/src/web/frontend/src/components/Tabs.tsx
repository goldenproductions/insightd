interface Tab {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({ tabs, active, onChange }: { tabs: Tab[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1" style={{ borderBottom: '1px solid var(--border)' }}>
      {tabs.map(tab => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative px-4 py-2 text-sm font-medium transition-colors ${!isActive ? 'hover-text-secondary' : ''}`}
            style={{ color: isActive ? 'var(--color-info)' : 'var(--text-muted)', marginBottom: '-1px' }}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-xs"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                {tab.count}
              </span>
            )}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                style={{ backgroundColor: 'var(--color-info)' }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
