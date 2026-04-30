interface Props {
  /** "namespace/stable/container" */
  containerName: string;
  /** Host (= node) the pod runs on. */
  hostId: string;
  /** Image string from the API (`update_checks.image`); null when not reported. */
  image: string | null;
  /** Raw labels JSON from `container_snapshots.labels`; null when missing. */
  labelsJson: string | null;
}

/**
 * K8s pod identity row that sits below the page title. Parses the
 * "namespace/stable/container" entity name into its parts and shows a
 * small set of labels (`app`, `version`, `app.kubernetes.io/*`) inline.
 *
 * Renders nothing when the container_name doesn't look like a k8s entity
 * (no slashes), so this component is safe to mount unconditionally.
 */
export function K8sIdentityStrip({ containerName, hostId, image, labelsJson }: Props) {
  const firstSlash = containerName.indexOf('/');
  if (firstSlash <= 0) return null;
  const namespace = containerName.slice(0, firstSlash);
  const rest = containerName.slice(firstSlash + 1);
  const secondSlash = rest.indexOf('/');
  const workload = secondSlash > 0 ? rest.slice(0, secondSlash) : rest;
  const containerOnly = secondSlash > 0 ? rest.slice(secondSlash + 1) : null;

  const labels = parseLabels(labelsJson);
  const featured = pickFeaturedLabels(labels);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-bg-secondary/40 px-3 py-2 text-xs">
      <Field label="Namespace" value={namespace} mono />
      <Field label="Workload" value={workload} mono />
      {containerOnly && <Field label="Container" value={containerOnly} mono />}
      <Field label="Node" value={hostId} mono />
      {image && <Field label="Image" value={image} mono title={image} truncate />}
      {featured.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          {featured.map(([k, v]) => (
            <span
              key={k}
              title={`${k}=${v}`}
              className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[10px] text-secondary"
            >
              {shortKey(k)}={v}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function Field({ label, value, mono, truncate, title }: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  title?: string;
}) {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span
        className={`text-fg ${mono ? 'font-mono' : ''} ${truncate ? 'max-w-[28ch] truncate' : ''}`}
      >
        {value}
      </span>
    </span>
  );
}

function parseLabels(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Surface a small, opinionated subset of labels — the ones a homelabber
// actually scans for ("which app is this?", "which version?"). Skipping
// controller-revision-hash, pod-template-hash, etc. avoids label noise.
const FEATURED_KEYS = [
  'app',
  'app.kubernetes.io/name',
  'app.kubernetes.io/instance',
  'app.kubernetes.io/component',
  'app.kubernetes.io/version',
  'version',
  'tier',
];

function pickFeaturedLabels(labels: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of FEATURED_KEYS) {
    if (labels[k]) out.push([k, labels[k]]);
  }
  return out;
}

function shortKey(k: string): string {
  // app.kubernetes.io/name → name
  const slash = k.lastIndexOf('/');
  return slash >= 0 ? k.slice(slash + 1) : k;
}
