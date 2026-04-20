import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { LinkButton } from './FormField';
import { SearchIcon, PlusIcon } from './Icons';
import type { Host, EndpointSummary } from '@/types/api';

interface SearchHit {
  type: 'host' | 'endpoint';
  label: string;
  sub: string;
  to: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|od|ad)/.test(navigator.platform);

interface TopbarProps {
  /** Left-side title text. Ignored when `leftContent` is provided. */
  title?: React.ReactNode;
  /** Left-side subtitle. Ignored when `leftContent` is provided. */
  subtitle?: React.ReactNode;
  /** Renders the entire left side. Use when the title is more than plain text (e.g. dashboard hero). */
  leftContent?: React.ReactNode;
  /** Page-specific actions, rendered to the left of the search box and Add agent button. */
  actions?: React.ReactNode;
}

export function Topbar({ title, subtitle, leftContent, actions }: TopbarProps) {
  const { isHubMode } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Lazy-fetch search corpora when search is focused. These query keys match
  // the rest of the app, so cached results are reused.
  const { data: hosts } = useQuery({
    queryKey: queryKeys.hosts(),
    queryFn: () => api<Host[]>('/hosts'),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: endpoints } = useQuery({
    queryKey: queryKeys.endpoints(),
    queryFn: () => api<EndpointSummary[]>('/endpoints'),
    enabled: open,
    staleTime: 30_000,
  });

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchHit[] = [];
    for (const h of hosts ?? []) {
      if (h.host_id.toLowerCase().includes(q)) {
        out.push({
          type: 'host',
          label: h.host_id,
          sub: h.runtime_type ?? 'host',
          to: `/hosts/${encodeURIComponent(h.host_id)}`,
        });
      }
    }
    for (const e of endpoints ?? []) {
      if (e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) {
        out.push({
          type: 'endpoint',
          label: e.name,
          sub: `${e.method} ${e.url}`,
          to: `/endpoints/${e.id}`,
        });
      }
    }
    return out.slice(0, 8);
  }, [query, hosts, endpoints]);

  useEffect(() => { setHighlight(0); }, [hits.length]);

  // ⌘K / Ctrl+K to focus the search input. Modifier-keyed shortcuts can't go
  // through the project's chord-based useKeyboardShortcut hook (it only
  // handles plain keys + sequences), so we use a window listener directly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setQuery('');
      inputRef.current?.blur();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      const hit = hits[highlight];
      if (hit) {
        navigate(hit.to);
        setQuery('');
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  const showDropdown = open && query.trim().length > 0;

  return (
    <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0 flex-1">
        {leftContent ?? (
          <>
            {title && <h1 className="truncate text-xl font-bold text-fg">{title}</h1>}
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
      <div ref={containerRef} className="relative hidden md:block">
        <div className="flex w-72 items-center gap-2 rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm transition-colors focus-within:border-info">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search hosts, endpoints…"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none"
          />
          <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10px] text-muted">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </div>
        {showDropdown && (
          <div
            role="listbox"
            className="absolute right-0 top-full z-20 mt-1.5 w-96 max-w-[80vw] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
          >
            {hits.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted">No matches.</div>
            ) : (
              hits.map((hit, i) => (
                <Link
                  key={`${hit.type}:${hit.label}`}
                  to={hit.to}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => { setQuery(''); setOpen(false); }}
                  className={`flex items-center gap-3 px-3 py-2 text-sm ${i === highlight ? 'bg-bg-secondary' : ''}`}
                >
                  <span className="rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-secondary">
                    {hit.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{hit.label}</span>
                  <span className="hidden truncate text-xs text-muted sm:inline">{hit.sub}</span>
                </Link>
              ))
            )}
          </div>
        )}
      </div>

      {isHubMode && (
        <LinkButton to="/add-agent" variant="primary" size="sm" className="inline-flex items-center gap-1.5">
          <PlusIcon className="h-3.5 w-3.5" />
          Add agent
        </LinkButton>
      )}
      </div>
    </div>
  );
}
