import { useState, useMemo, useCallback } from 'react';
import type { ContainerSnapshot } from '@/types/api';
import { getContainerNamespace } from '@/lib/containers';

const STORAGE_PREFIX = 'insightd.nsFilter.';

function loadHidden(hostId: string): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + hostId);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveHidden(hostId: string, hidden: Set<string>): void {
  try {
    if (hidden.size === 0) localStorage.removeItem(STORAGE_PREFIX + hostId);
    else localStorage.setItem(STORAGE_PREFIX + hostId, JSON.stringify(Array.from(hidden)));
  } catch { /* quota exceeded */ }
}

export function useNamespaceFilter(containers: ContainerSnapshot[], hostId: string) {
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(hostId));

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
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      saveHidden(hostId, next);
      return next;
    });
  }, [hostId]);

  const showAll = useCallback(() => {
    setHidden(new Set());
    saveHidden(hostId, new Set());
  }, [hostId]);

  return { namespaces, hidden, filtered, toggle, showAll, isKubernetes };
}
