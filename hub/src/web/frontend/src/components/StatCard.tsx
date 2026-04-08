import { Link } from 'react-router-dom';
import type { MetricRating } from '@/lib/ratings';
import { ratingColors } from '@/lib/ratings';

export function StatsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {children}
    </div>
  );
}

export function StatCard({ value, label, color, rating, to, analogy }: { value: React.ReactNode; label: string; color?: string; rating?: MetricRating | null; to?: string; analogy?: { emoji: string; label: string } | null }) {
  const content = (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-2xl font-bold text-fg" style={color || rating ? { color: color || ratingColors[rating!.rating] } : undefined}>
        {value}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {rating && (
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${ratingColors[rating.rating]}20`, color: ratingColors[rating.rating] }}>
            {rating.label} {rating.rating}
          </span>
        )}
      </div>
      {analogy && (
        <div className="text-[10px] text-muted mt-0.5">{analogy.emoji} {analogy.label}</div>
      )}
    </div>
  );

  if (to) {
    return <Link to={to} className="block transition-opacity hover:opacity-80">{content}</Link>;
  }
  return content;
}
