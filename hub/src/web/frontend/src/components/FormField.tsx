interface Props {
  label: string;
  children: React.ReactNode;
  description?: string;
  hint?: string;
  source?: string;
}

export function FormField({ label, children, description, hint, source }: Props) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text)' }}>
        {label}
        {hint && <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>({hint})</span>}
        {source && <span className="rounded-full px-1.5 py-0.5 text-xs" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>{source}</span>}
      </label>
      {children}
      {description && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{description}</p>}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors ${props.className || ''}`}
      style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)', ...props.style }}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors ${props.className || ''}`}
      style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)', ...props.style }}
    />
  );
}

export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'secondary' }) {
  const base = 'rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50';
  const styles = {
    primary: `${base} bg-blue-600 text-white hover:bg-blue-700`,
    danger: `${base} bg-red-600 text-white hover:bg-red-700`,
    secondary: `${base} hover:opacity-80`,
  };
  return <button {...props} className={styles[variant]} style={variant === 'secondary' ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' } : undefined} />;
}
