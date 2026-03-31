export function StatsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {children}
    </div>
  );
}

export function StatCard({ value, label, color }: { value: React.ReactNode; label: string; color?: string }) {
  return (
    <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="text-2xl font-bold" style={{ color: color || 'var(--text)' }}>
        {value}
      </div>
      <div className="mt-0.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
    </div>
  );
}
