import { useState } from 'react';

export function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg p-4 text-sm" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}>
        {command}
      </pre>
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
