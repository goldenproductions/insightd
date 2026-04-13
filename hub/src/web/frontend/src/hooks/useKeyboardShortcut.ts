import { useEffect, useRef } from 'react';
import { useShortcutsContext, type ShortcutDef } from '@/context/ShortcutsContext';

export interface UseKeyboardShortcutOptions extends Omit<ShortcutDef, 'onTrigger'> {
  onTrigger: () => void;
  /** When true, the shortcut is not registered. Useful for auth-gated actions. */
  disabled?: boolean;
}

/**
 * Register a keyboard shortcut while the component is mounted. The most
 * recently-mounted shortcut wins when multiple components register the same
 * key, so page-level shortcuts naturally shadow globals.
 *
 * The latest `onTrigger` is always called — the registration tracks a ref so
 * callers don't need to memoize their callbacks.
 */
export function useKeyboardShortcut({ keys, description, scope, onTrigger, disabled }: UseKeyboardShortcutOptions) {
  const { register } = useShortcutsContext();
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;

  useEffect(() => {
    if (disabled) return;
    const unregister = register({
      keys,
      description,
      scope,
      onTrigger: () => triggerRef.current(),
    });
    return unregister;
  }, [keys, description, scope, disabled, register]);
}
