import { Topbar } from './Topbar';

export function PageTitle({ children, actions, subtitle }: { children: React.ReactNode; actions?: React.ReactNode; subtitle?: React.ReactNode }) {
  return <Topbar title={children} subtitle={subtitle} actions={actions} />;
}
