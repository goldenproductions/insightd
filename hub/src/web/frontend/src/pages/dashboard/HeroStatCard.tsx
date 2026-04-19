import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';

export type PillColor = 'green' | 'red' | 'yellow' | 'blue' | 'gray';

interface HeroStatCardProps {
  title: string;
  value: React.ReactNode;
  pill?: { text: string; color: PillColor };
  sub?: React.ReactNode;
  to?: string;
}

export function HeroStatCard({ title, value, pill, sub, to }: HeroStatCardProps) {
  const inner = (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h3>
        {pill && <Badge text={pill.text} color={pill.color} />}
      </div>
      <div className="mt-2 text-2xl font-bold leading-tight tabular-nums tracking-tight text-fg">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </Card>
  );
  if (to) return <Link to={to} className="block transition-opacity hover:opacity-80">{inner}</Link>;
  return inner;
}
