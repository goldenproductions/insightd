import { useEffect, useMemo, useRef } from 'react';
import { useShortcutsContext } from '@/context/ShortcutsContext';

/** Render a single key or key sequence as monospace kbd pills. */
function KeyBadge({ keys }: { keys: string }) {
  const parts = keys.split(' ');
  return (
    <span className="flex items-center gap-1">
      {parts.map((p, i) => (
        <kbd
          key={i}
          className="min-w-[1.5rem] rounded border border-border bg-bg-secondary px-1.5 py-0.5 text-center font-mono text-[11px] font-medium text-fg"
        >
          {p === ' ' ? '␣' : p}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutHelpModal() {
  const { registered, helpOpen, setHelpOpen } = useShortcutsContext();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (helpOpen) ref.current?.showModal();
    else ref.current?.close();
  }, [helpOpen]);

  // Group by scope, preserve stable order within a scope.
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof registered>();
    for (const s of registered) {
      const list = groups.get(s.scope) ?? [];
      list.push(s);
      groups.set(s.scope, list);
    }
    return Array.from(groups.entries());
  }, [registered]);

  return (
    <dialog
      ref={ref}
      onClose={() => setHelpOpen(false)}
      className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lg backdrop:bg-black/50"
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-fg">Keyboard shortcuts</h3>
        <button
          onClick={() => setHelpOpen(false)}
          className="text-sm text-muted hover:text-fg"
          aria-label="Close"
        >
          Esc
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="text-sm text-muted">No shortcuts registered for this page.</p>
      ) : (
        <div className="space-y-5">
          {grouped.map(([scope, shortcuts]) => (
            <div key={scope}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">{scope}</h4>
              <ul className="space-y-1.5">
                {shortcuts.map(s => (
                  <li key={s.keys} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-fg">{s.description}</span>
                    <KeyBadge keys={s.keys} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 border-t border-border-light pt-3 text-[11px] text-muted">
        Shortcuts are disabled while typing in a form field.
      </p>
    </dialog>
  );
}
