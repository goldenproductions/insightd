export function VolumesTab() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface p-8">
      <div className="mx-auto max-w-lg text-center">
        <div className="mb-2 text-sm font-semibold text-fg">Docker volumes</div>
        <p className="text-sm text-secondary">
          Coming soon: full volume inventory with on-disk size, driver, and which containers mount them.
        </p>
        <ul className="mx-auto mt-4 max-w-sm space-y-1.5 text-left text-sm text-muted">
          <li>&bull; Orphaned volumes wasting space</li>
          <li>&bull; Volume size by host and driver</li>
          <li>&bull; Link volumes to the containers using them</li>
        </ul>
      </div>
    </div>
  );
}
