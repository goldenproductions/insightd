import { useRef, useEffect } from 'react';
import { Button } from '@/components/FormField';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onCancel}
      className="rounded-xl border border-border bg-surface p-6 shadow-lg backdrop:bg-black/50"
    >
      <h3 className="text-lg font-bold text-fg">{title}</h3>
      <p className="mt-2 text-sm text-secondary">{message}</p>
      <div className="mt-4 flex justify-end gap-3">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
