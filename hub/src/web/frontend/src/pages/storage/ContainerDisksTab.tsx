export function ContainerDisksTab() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface p-8">
      <div className="mx-auto max-w-lg text-center">
        <div className="mb-2 text-sm font-semibold text-fg">Per-container disk sizing</div>
        <p className="text-sm text-secondary">
          Coming soon: writable layer + rootfs size for every container, aggregated by host and image.
        </p>
        <ul className="mx-auto mt-4 max-w-sm space-y-1.5 text-left text-sm text-muted">
          <li>&bull; Largest containers by writable layer</li>
          <li>&bull; Growth trend per container</li>
          <li>&bull; Flag containers leaking disk (logs, caches)</li>
        </ul>
      </div>
    </div>
  );
}
