const styles: Record<string, string> = {
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  yellow: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

interface Props {
  message: string;
  color?: string;
  /** If provided, renders a dismiss (×) button that calls this on click. */
  onDismiss?: () => void;
}

export function AlertBanner({ message, color = 'green', onDismiss }: Props) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-2.5 text-sm ${styles[color] || styles.green}`}>
      <div className="flex-1">{message}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded px-1 text-base leading-none opacity-60 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}
