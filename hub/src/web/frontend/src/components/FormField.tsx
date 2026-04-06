import React, { useId } from 'react';

interface Props {
  label: string;
  children: React.ReactNode;
  description?: string;
  hint?: string;
  source?: string;
}

export function FormField({ label, children, description, hint, source }: Props) {
  const id = useId();
  const fieldId = `field-${id}`;
  const descId = description ? `desc-${id}` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="flex items-center gap-2 text-sm font-medium text-fg">
        {label}
        {hint && <span className="text-xs font-normal text-muted">({hint})</span>}
        {source && <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-xs text-muted">{source}</span>}
      </label>
      {React.Children.map(children, (child, index) =>
        index === 0 && React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
              id: fieldId,
              ...(descId ? { 'aria-describedby': descId } : {}),
            })
          : child
      )}
      {description && <p id={descId} className="text-xs text-muted">{description}</p>}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none transition-colors ${props.className || ''}`}
      style={props.style}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-fg outline-none transition-colors ${props.className || ''}`}
      style={props.style}
    />
  );
}

export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'secondary' }) {
  const base = 'rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50';
  const styles = {
    primary: `${base} bg-blue-600 text-white hover:bg-blue-700`,
    danger: `${base} bg-red-600 text-white hover:bg-red-700`,
    secondary: `${base} border border-border bg-bg-secondary text-fg hover:opacity-80`,
  };
  return <button {...props} className={styles[variant]} />;
}
