export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl p-4 lg:p-5 ${className}`} style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
      {title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>{title}</h2>}
      {children}
    </div>
  );
}
