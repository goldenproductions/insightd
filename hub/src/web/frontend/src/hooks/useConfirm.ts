import { useState, useCallback } from 'react';

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: ((value: boolean) => void) | null;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>({
    open: false, title: '', message: '', confirmLabel: 'Confirm', danger: false, resolve: null,
  });

  const confirm = useCallback((options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> => {
    return new Promise(resolve => {
      setState({
        open: true,
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel || 'Confirm',
        danger: options.danger || false,
        resolve,
      });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    state.resolve?.(true);
    setState(prev => ({ ...prev, open: false, resolve: null }));
  }, [state.resolve]);

  const handleCancel = useCallback(() => {
    state.resolve?.(false);
    setState(prev => ({ ...prev, open: false, resolve: null }));
  }, [state.resolve]);

  return { confirm, dialogProps: { ...state, onConfirm: handleConfirm, onCancel: handleCancel } };
}
