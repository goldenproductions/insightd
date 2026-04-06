export function PageTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-bold text-fg">{children}</h1>
      {actions}
    </div>
  );
}
