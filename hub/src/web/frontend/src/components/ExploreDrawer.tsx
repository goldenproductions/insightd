import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** Sub-line shown under the drawer title for orientation. */
  description?: string;
  children: ReactNode;
}

const DRAWER_WIDTH = 420;

/**
 * Side drawer for deep-dive signals (historical anomalies, log templates).
 *
 * Rendered via a portal to `document.body` so it sits outside the page tree
 * and is not affected by the route-level `animate-page-enter` fade-in. This
 * prevents the pull-tab from "flashing" during route transitions.
 *
 * The drawer's open state drives a `data-explore-open` body attribute that
 * shifts the main content left via a CSS rule in `index.css`.
 */
export function ExploreDrawer({ description, children }: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Mount the portal target after first paint so transitions can't animate
  // from any pre-mount baseline.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Body attribute drives the main-content shift in index.css. Sync flag on
  // every commit + cleanup on unmount so route changes can't leave it stuck.
  useLayoutEffect(() => {
    if (open) document.body.setAttribute('data-explore-open', '');
    else document.body.removeAttribute('data-explore-open');
    return () => document.body.removeAttribute('data-explore-open');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!mounted) return null;

  const tabTransform = open ? `translate(-${DRAWER_WIDTH}px, -50%)` : 'translate(0, -50%)';
  const drawerTransform = open ? 'translateX(0)' : 'translateX(100%)';

  return createPortal(
    <>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={open ? 'Close explore panel' : 'Open explore panel'}
        title={open ? 'Close (Esc)' : 'Explore deeper signals'}
        className="fixed right-0 top-1/2 z-30 flex flex-col items-center gap-1.5 rounded-l-md border border-r-0 border-border bg-surface px-1.5 py-3 text-xs font-medium text-muted shadow-sm transition-transform duration-300 ease-out hover:bg-surface-hover hover:text-fg"
        style={{ transform: tabTransform }}
      >
        <span aria-hidden className="text-base leading-none">{open ? '›' : '‹'}</span>
        <span className="rotate-180 text-[10px] font-semibold uppercase tracking-[0.15em] [writing-mode:vertical-rl]">
          {open ? 'Hide' : 'Explore'}
        </span>
      </button>

      <aside
        aria-hidden={!open}
        aria-label="Explore details"
        className="fixed right-0 top-0 z-20 h-screen max-w-[100vw] border-l border-border bg-bg shadow-xl transition-transform duration-300 ease-out"
        style={{ width: DRAWER_WIDTH, transform: drawerTransform }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-fg">Explore</div>
            {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            tabIndex={open ? 0 : -1}
            className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            ✕
          </button>
        </header>
        <div className="h-[calc(100vh-57px)] space-y-4 overflow-y-auto p-4">
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}
