const styles: Record<string, string> = {
  green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  red: 'bg-red-500/10 text-red-600 dark:text-red-400',
  yellow: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  gray: 'bg-gray-500/10 text-gray-600 dark:text-gray-400',
};

export function Badge({ text, color = 'gray' }: { text: string; color?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[color] || styles.gray}`}>
      {text}
    </span>
  );
}
