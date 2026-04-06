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
      <pre ref={preRef} className="overflow-x-auto rounded-lg border border-border bg-bg-secondary p-4 text-sm text-fg">
        {command}
      </pre>
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-secondary transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
