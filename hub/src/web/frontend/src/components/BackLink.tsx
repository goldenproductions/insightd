import { Link } from 'react-router-dom';

export function BackLink({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="text-sm text-info hover:underline">&larr; {label}</Link>;
}
