import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ContainerSnapshot } from '@/types/api';
import { getContainerNamespace } from '@/lib/containers';

const STORAGE_PREFIX = 'insightd.nsFilter.';
const PARAM = 'ns';

function loadLegacyHidden(hostId: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + hostId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function useNamespaceFilter(containers: ContainerSnapshot[], hostId: string) {
  const [searchParams, setSearchParams] = useSearchParams();

  const hidden = useMemo(() => {
    const raw = searchParams.get(PARAM) ?? '';
    return new Set(raw.split(',').filter(Boolean));
  }, [searchParams]);

  // One-shot migration: if the URL is empty for this host but localStorage
  // has a pre-existing hide list, promote it to the URL and clear storage.
  // Silent — homelab audience won't notice and the alternative is a toast.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    if (searchParams.get(PARAM)) return;
    const legacy = loadLegacyHidden(hostId);
    if (legacy.length === 0) return;
    const next = new URLSearchParams(searchParams);
    next.set(PARAM, legacy.join(','));
    setSearchParams(next, { replace: true });
    try { localStorage.removeItem(STORAGE_PREFIX + hostId); } catch { /* ignore */ }
  }, [hostId, searchParams, setSearchParams]);

  const writeHidden = useCallback((next: Set<string>) => {
    const params = new URLSearchParams(searchParams);
    if (next.size === 0) params.delete(PARAM);
    else params.set(PARAM, Array.from(next).join(','));
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const namespaces = useMemo(() => {
    const ns = new Set<string>();
    for (const c of containers) {
      const n = getContainerNamespace(c.container_name);
      if (n) ns.add(n);
    }
    return Array.from(ns).sort();
  }, [containers]);

  const isKubernetes = namespaces.length > 0;

  const filtered = useMemo(() => {
    if (hidden.size === 0) return containers;
    return containers.filter(c => {
      const ns = getContainerNamespace(c.container_name);
      return !ns || !hidden.has(ns);
    });
  }, [containers, hidden]);

  const toggle = useCallback((ns: string) => {
    const next = new Set(hidden);
    if (next.has(ns)) next.delete(ns);
    else next.add(ns);
    writeHidden(next);
  }, [hidden, writeHidden]);

  const showAll = useCallback(() => {
    writeHidden(new Set());
  }, [writeHidden]);

  return { namespaces, hidden, filtered, toggle, showAll, isKubernetes };
}
