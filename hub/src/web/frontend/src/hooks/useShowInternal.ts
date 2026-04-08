import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import React from 'react';

interface ShowInternalState {
  showInternal: boolean;
  toggleShowInternal: () => void;
}

const ShowInternalContext = createContext<ShowInternalState | null>(null);

const STORAGE_KEY = 'insightd-show-internal';

export function ShowInternalProvider({ children }: { children: ReactNode }) {
  const [showInternal, setShowInternal] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true');

  const toggleShowInternal = useCallback(() => {
    setShowInternal(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return React.createElement(ShowInternalContext.Provider, { value: { showInternal, toggleShowInternal } }, children);
}

export function useShowInternal() {
  const ctx = useContext(ShowInternalContext);
  if (!ctx) throw new Error('useShowInternal must be used within ShowInternalProvider');
  return ctx;
}
