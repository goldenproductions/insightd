import type { BaselinePercentiles, BaselineRow } from '@/types/api';

export type MetricType = 'cpu' | 'memory' | 'disk' | 'network' | 'load' | 'temperature' | 'health';

export interface Analogy {
  emoji: string;
  label: string;
}

type Tier = [number, string, string]; // [threshold, emoji, label]

// --- Static fallback tiers (used when no baseline exists) ---

const CPU_TIERS: Tier[] = [
  [95, '💀', 'Burnout'],
  [80, '🔥', 'On fire'],
  [65, '😰', 'Sweating'],
  [40, '💪', 'Working hard'],
  [15, '😌', 'Chilling'],
  [0,  '😴', 'Napping'],
];

const MEMORY_TIERS: Tier[] = [
  [95, '💀', 'Total blackout'],
  [85, '🫠', "Alzheimer's"],
  [70, '😵', 'Forgetting things'],
  [50, '🤔', 'Getting foggy'],
  [30, '🧠', 'Sharp'],
  [0,  '🧒', 'Sharp as a kid'],
];

const DISK_TIERS: Tier[] = [
  [95, '💀', 'Starving for space'],
  [85, '🤢', 'About to burst'],
  [70, '🫃', 'Stuffed'],
  [50, '🤰', 'Food baby'],
  [30, '😋', 'Well fed'],
  [0,  '🍽️', 'Room for dessert'],
];

const NETWORK_TIERS: Tier[] = [
  [100_000_000, '🤯', 'Panic attack'],
  [10_000_000,  '😰', 'Hyperventilating'],
  [1_000_000,   '🏃', 'Sprinting'],
  [100_000,     '🚶', 'Light jog'],
  [0,           '😌', 'Zen mode'],
];

const LOAD_TIERS: Tier[] = [
  [4.0, '💀', 'Drowning'],
  [2.0, '😰', 'Overcommitted'],
  [1.0, '💪', 'Pumped'],
  [0.5, '☕', 'Caffeinated'],
  [0,   '😴', 'Barely awake'],
];

const TEMP_TIERS: Tier[] = [
  [80, '🔥', 'Meltdown'],
  [70, '🥵', 'Fever'],
  [55, '🌡️', 'Warming up'],
  [40, '😎', 'Cool'],
  [0,  '🧊', 'Ice cold'],
];

const HEALTH_TIERS: Tier[] = [
  [90, '💚', 'Thriving'],
  [70, '💛', 'Coping'],
  [50, '🧡', 'Struggling'],
  [0,  '❤️', 'Life support'],
];

const TIER_MAP: Record<MetricType, Tier[]> = {
  cpu: CPU_TIERS,
  memory: MEMORY_TIERS,
  disk: DISK_TIERS,
  network: NETWORK_TIERS,
  load: LOAD_TIERS,
  temperature: TEMP_TIERS,
  health: HEALTH_TIERS,
};

function matchTier(tiers: Tier[], value: number): Analogy {
  for (const [threshold, emoji, label] of tiers) {
    if (value >= threshold) return { emoji, label };
  }
  const last = tiers[tiers.length - 1]!;
  return { emoji: last[1], label: last[2] };
}

// --- Baseline-aware tiers ---
// Compares value against the entity's own percentiles.
// "Normal" is defined by what THIS container/host usually does.

function matchBaseline(value: number, bl: BaselinePercentiles): Analogy {
  if (bl.p99 != null && value >= bl.p99) return { emoji: '💀', label: 'Uncharted territory' };
  if (bl.p95 != null && value >= bl.p95) return { emoji: '🔥', label: 'Way above normal' };
  if (bl.p90 != null && value >= bl.p90) return { emoji: '😰', label: 'Above normal' };
  if (bl.p75 != null && value >= bl.p75) return { emoji: '💪', label: 'Busy for this one' };
  if (bl.p50 != null && value >= bl.p50) return { emoji: '😌', label: 'Normal' };
  return { emoji: '😴', label: 'Below normal' };
}

/**
 * Get a human-friendly analogy for a metric value.
 *
 * When a baseline is provided, the analogy is relative to the entity's
 * own history ("Above normal" means above what THIS container usually does).
 * Without a baseline, falls back to static thresholds.
 *
 * For percentage metrics (cpu, memory, disk, health): pass 0-100.
 * For memory in MB with a max: pass (used, total) and it computes %.
 * For network/disk I/O: pass bytes/sec.
 * For load: pass raw load average.
 * For temperature: pass celsius.
 */
export function getAnalogy(
  metric: MetricType,
  value: number | null | undefined,
  max?: number | null,
  baseline?: BaselinePercentiles | null,
): Analogy | null {
  if (value == null) return null;
  let v = value;
  if (max && max > 0 && (metric === 'memory' || metric === 'disk')) {
    v = (value / max) * 100;
  }

  // Use baseline-aware comparison when available (not for health/temperature/network which use absolute thresholds)
  if (baseline && baseline.p50 != null && metric !== 'health' && metric !== 'temperature') {
    return matchBaseline(v, baseline);
  }

  return matchTier(TIER_MAP[metric], v);
}

/** Extract the percentile subset from a BaselineRow array for a given metric. */
export function findBaseline(baselines: BaselineRow[] | undefined, metric: string): BaselinePercentiles | null {
  if (!baselines) return null;
  const row = baselines.find(b => b.metric === metric && b.time_bucket === 'all');
  if (!row || row.p50 == null) return null;
  return { p50: row.p50, p75: row.p75, p90: row.p90, p95: row.p95, p99: row.p99 };
}
