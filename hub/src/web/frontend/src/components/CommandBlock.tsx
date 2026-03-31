import { useState, useRef } from 'react';

export function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const copy = async () => {
    try {
      // Try modern clipboard API first (requires HTTPS or localhost)
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback for HTTP: select text and use execCommand
      if (preRef.current) {
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand('copy');
        selection?.removeAllRanges();
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre ref={preRef} className="overflow-x-auto rounded-lg p-4 text-sm" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)' }}>
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
