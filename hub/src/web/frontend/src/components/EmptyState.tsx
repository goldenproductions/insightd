export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-muted">{message}</p>
    </div>
  );
}
