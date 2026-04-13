import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ShortcutDef {
  /** Key or space-separated sequence, e.g. "r", "g h", "?". */
  keys: string;
  /** Human-readable description for the help modal. */
  description: string;
  /** Group heading in the help modal, e.g. "Global", "Container detail". */
  scope: string;
  /** Callback fired when the shortcut matches. */
  onTrigger: () => void;
}

interface ShortcutsContextValue {
  register: (def: ShortcutDef) => () => void;
  /** Snapshot of currently-registered shortcuts, for the help modal. */
  registered: ShortcutDef[];
  /** Open/close the help modal. */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

/** Is the event target an element where single-key shortcuts should NOT fire? */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Normalize a KeyboardEvent into our lookup key. Letters lowercase, others pass-through. */
function normalizeKey(e: KeyboardEvent): string | null {
  // Ignore pure modifier presses
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;
  // Don't intercept browser shortcuts
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // Normalize letters to lowercase so Shift+/ gives "?" naturally via e.key
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  // Stack of registrations per key, newest last. Last registered wins so that
  // page-level shortcuts shadow globals while the page is mounted.
  const stacksRef = useRef<Map<string, ShortcutDef[]>>(new Map());
  // Mirror as state so consumers (help modal) re-render when things change.
  const [registered, setRegistered] = useState<ShortcutDef[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);

  const rebuildSnapshot = useCallback(() => {
    const snapshot: ShortcutDef[] = [];
    for (const stack of stacksRef.current.values()) {
      if (stack.length > 0) snapshot.push(stack[stack.length - 1]!);
    }
    setRegistered(snapshot);
  }, []);

  const register = useCallback((def: ShortcutDef) => {
    const stack = stacksRef.current.get(def.keys) ?? [];
    stack.push(def);
    stacksRef.current.set(def.keys, stack);
    rebuildSnapshot();
    return () => {
      const current = stacksRef.current.get(def.keys);
      if (!current) return;
      const idx = current.lastIndexOf(def);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) stacksRef.current.delete(def.keys);
      rebuildSnapshot();
    };
  }, [rebuildSnapshot]);

  // Central key handler. Lives on window so shortcuts work regardless of focus.
  useEffect(() => {
    let buffer = '';
    let timer: number | null = null;

    const clearBuffer = () => {
      buffer = '';
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const key = normalizeKey(e);
      if (key == null) return;

      const candidate = buffer ? `${buffer} ${key}` : key;
      const stack = stacksRef.current.get(candidate);
      if (stack && stack.length > 0) {
        e.preventDefault();
        clearBuffer();
        stack[stack.length - 1]!.onTrigger();
        return;
      }

      // Look for shortcuts where `candidate` is a prefix (enable sequence mode).
      let isPrefix = false;
      for (const k of stacksRef.current.keys()) {
        if (k.startsWith(`${candidate} `)) {
          isPrefix = true;
          break;
        }
      }
      if (isPrefix) {
        buffer = candidate;
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(clearBuffer, 1000);
        return;
      }

      clearBuffer();
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const value = useMemo<ShortcutsContextValue>(() => ({
    register,
    registered,
    helpOpen,
    setHelpOpen,
  }), [register, registered, helpOpen]);

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}

export function useShortcutsContext(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error('useShortcutsContext must be used inside ShortcutsProvider');
  return ctx;
}
