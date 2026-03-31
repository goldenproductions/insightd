const styles: Record<string, string> = {
  green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  yellow: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

export function AlertBanner({ message, color = 'green' }: { message: string; color?: string }) {
  return (
    <div className={`rounded-lg border px-4 py-2.5 text-sm ${styles[color] || styles.green}`}>
      {message}
    </div>
  );
}
