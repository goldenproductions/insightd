import { useState } from 'react';
import { GLOSSARY } from '@/lib/glossary';
import { GlossaryDialog } from './GlossaryDialog';

interface Props {
  /** Glossary entry id to open the dialog on. Must exist in `lib/glossary.ts`. */
  topic: string;
  /** Optional accessible label override (defaults to "Learn about: <title>"). */
  label?: string;
  /** Visual size — `xs` for inline pills, `sm` for card titles. */
  size?: 'xs' | 'sm';
  /** Extra Tailwind classes for layout (e.g. `ml-1`). */
  className?: string;
}

/**
 * Inline `?` button that opens the GlossaryDialog focused on `topic`.
 * Drop next to any term that needs explaining; the explanation lives in
 * `lib/glossary.ts`, not in the calling component.
 */
export function GlossaryHelp({ topic, label, size = 'xs', className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const entry = GLOSSARY.get(topic);
  const ariaLabel = label ?? (entry ? `Learn about: ${entry.title}` : 'Open glossary');

  // Don't render the button if the topic id is bogus — fail loud during dev,
  // silent in prod. Returning null here is preferable to a dead-end click.
  if (!entry) {
    if (typeof console !== 'undefined') console.warn(`[GlossaryHelp] unknown topic "${topic}"`);
    return null;
  }

  const sizeCls = size === 'sm' ? 'h-5 w-5 text-[11px]' : 'h-4 w-4 text-[10px]';

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={ariaLabel}
        title={entry.blurb}
        className={`inline-flex items-center justify-center rounded-full border border-border bg-bg-secondary font-semibold text-muted transition-colors hover:border-info/50 hover:bg-info/10 hover:text-info ${sizeCls} ${className}`}
      >
        ?
      </button>
      <GlossaryDialog open={open} topic={topic} onClose={() => setOpen(false)} />
    </>
  );
}
