import { useEffect, useRef, useState } from 'react';
import { GLOSSARY, GLOSSARY_BY_CATEGORY, type GlossaryEntry } from '@/lib/glossary';

interface Props {
  open: boolean;
  /** The entry id to focus on when opened. Falls back to the first entry. */
  topic?: string;
  onClose: () => void;
}

export function GlossaryDialog({ open, topic, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<string>(() => topic ?? firstEntryId());

  // Sync open state with the native <dialog> imperatively (matches ConfirmDialog).
  useEffect(() => {
    if (!ref.current) return;
    if (open) {
      if (!ref.current.open) ref.current.showModal();
    } else {
      if (ref.current.open) ref.current.close();
    }
  }, [open]);

  // Reset to the requested topic each time the dialog opens.
  useEffect(() => {
    if (open && topic && GLOSSARY.has(topic)) setActive(topic);
  }, [open, topic]);

  const entry = GLOSSARY.get(active) ?? GLOSSARY.get(firstEntryId())!;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (not on the inner card) closes.
        if (e.target === ref.current) onClose();
      }}
      className="fixed left-1/2 top-1/2 m-0 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl rounded-xl border border-border bg-surface p-0 shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-md"
    >
      <div className="flex h-[min(80vh,640px)] min-h-[420px] flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-info/10 px-1.5 py-0.5 text-[11px] font-semibold text-info">Glossary</span>
            <h3 className="text-sm font-semibold text-fg">Insightd terminology</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-1 min-h-0">
          <nav aria-label="Glossary topics" className="w-56 shrink-0 overflow-y-auto border-r border-border bg-bg-secondary/40 p-3">
            {GLOSSARY_BY_CATEGORY.map(group => (
              <div key={group.category} className="mb-3">
                <div className="mb-1 px-2 text-xs font-semibold text-secondary">{group.category}</div>
                <ul className="space-y-0.5">
                  {group.entries.map(e => {
                    const isActive = e.id === active;
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => setActive(e.id)}
                          className={`block w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                            isActive
                              ? 'bg-info/10 font-medium text-info'
                              : 'text-secondary hover:bg-surface-hover hover:text-fg'
                          }`}
                        >
                          {e.title}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <article className="flex-1 overflow-y-auto px-6 py-5">
            <h2 className="text-lg font-bold text-fg">{entry.title}</h2>
            <p className="mt-1 text-sm text-muted">{entry.blurb}</p>
            <div className="mt-4 space-y-2.5">{entry.body}</div>

            {entry.related && entry.related.length > 0 && (
              <RelatedTopics ids={entry.related} onJump={setActive} />
            )}
          </article>
        </div>
      </div>
    </dialog>
  );
}

function RelatedTopics({ ids, onJump }: { ids: string[]; onJump: (id: string) => void }) {
  const valid = ids.map(id => GLOSSARY.get(id)).filter((e): e is GlossaryEntry => e != null);
  if (valid.length === 0) return null;
  return (
    <div className="mt-6 border-t border-border pt-4">
      <div className="mb-2 text-xs font-semibold text-secondary">See also</div>
      <div className="flex flex-wrap gap-2">
        {valid.map(e => (
          <button
            key={e.id}
            type="button"
            onClick={() => onJump(e.id)}
            className="rounded border border-border bg-bg px-2 py-1 text-xs text-secondary transition-colors hover:border-info/50 hover:bg-info/10 hover:text-info"
          >
            {e.title} →
          </button>
        ))}
      </div>
    </div>
  );
}

function firstEntryId(): string {
  const first = GLOSSARY_BY_CATEGORY[0]?.entries[0]?.id;
  if (!first) throw new Error('Glossary has no entries');
  return first;
}
