interface Props {
  score: number;
  size?: 'sm' | 'md' | 'lg';
}

function scoreColor(score: number): string {
  if (score >= 90) return 'var(--color-success)';
  if (score >= 70) return 'var(--color-warning)';
  if (score >= 50) return '#f97316';
  return 'var(--color-danger)';
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Healthy';
  if (score >= 70) return 'Fair';
  if (score >= 50) return 'Degraded';
  return 'Critical';
}

export function HealthBadge({ score, size = 'md' }: Props) {
  const color = scoreColor(score);
  const dim = size === 'lg' ? 64 : size === 'md' ? 48 : 36;
  const fontSize = size === 'lg' ? 'text-lg' : size === 'md' ? 'text-sm' : 'text-xs';
  const strokeWidth = size === 'lg' ? 4 : 3;
  const radius = (dim - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="-rotate-90">
          <circle cx={dim / 2} cy={dim / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
          <circle cx={dim / 2} cy={dim / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={circumference - progress} strokeLinecap="round" />
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center font-bold ${fontSize}`} style={{ color }}>
          {score}
        </span>
      </div>
      <span className="text-[10px] font-medium" style={{ color }}>{scoreLabel(score)}</span>
    </div>
  );
}
