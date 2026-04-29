import type { ReactNode } from 'react';
import { createElement as h, Fragment } from 'react';

export interface GlossaryEntry {
  id: string;
  title: string;
  category: string;
  /** One-line description shown in the topic list. */
  blurb: string;
  /** Full explanation rendered in the dialog body. */
  body: ReactNode;
  /** Other entry ids the reader might want to jump to. */
  related?: string[];
}

const Para = (...children: ReactNode[]) => h('p', { className: 'text-sm text-fg leading-relaxed' }, ...children);
const Code = (text: string) => h('code', { className: 'rounded bg-bg-secondary px-1 py-0.5 font-mono text-[12px] text-fg' }, text);
const Strong = (text: string) => h('strong', { className: 'font-semibold text-fg' }, text);
const H = (text: string) => h('h4', { className: 'mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted' }, text);
const List = (items: ReactNode[]) =>
  h('ul', { className: 'space-y-1 pl-4 list-disc text-sm text-fg' },
    ...items.map((it, i) => h('li', { key: i, className: 'leading-relaxed' }, it)));
const Group = (...children: ReactNode[]) => h(Fragment, null, ...children);

const ENTRIES: GlossaryEntry[] = [
  {
    id: 'robust-z',
    title: 'Robust z-score',
    category: 'Statistics',
    blurb: 'How far the live value sits from the baseline median, scaled by MAD',
    related: ['mad', 'baselines', 'capacity-floor'],
    body: Group(
      Para(
        'The robust z-score answers ',
        Strong('"how unusual is this value, given history?"'),
        ' It measures the absolute distance between the current value and the baseline median ',
        Code('p50'),
        ', divided by the baseline\'s MAD (median absolute deviation).',
      ),
      H('Formula'),
      Para(Code('z = |live − p50| / mad')),
      H('Rule of thumb'),
      List([
        Group(Code('z < 2'), ' — normal. Sits inside the typical band.'),
        Group(Code('2 ≤ z < 5'), ' — elevated. Worth a look but rarely actionable on its own.'),
        Group(Code('z ≥ 5'), ' — anomalous. Statistically rare; usually the headline of an insight.'),
      ]),
      H('Why "robust"?'),
      Para(
        'A traditional z-score uses mean and standard deviation, which are dragged around by a single outlier. ',
        'Robust z uses median + MAD instead, so one bad spike doesn\'t poison every future score. ',
        'This matters because monitoring data is full of one-off spikes (cron jobs, deploys, backups).',
      ),
      H('When z is null'),
      Para(
        'You\'ll see a dash instead of a z-score when MAD couldn\'t be computed — usually because the bucket has fewer than 10 samples, or every recorded value was identical (MAD = 0). ',
        'In that case the chart-style mini-bar in the Baselines viewer is a better signal than the score itself.',
      ),
    ),
  },
  {
    id: 'mad',
    title: 'MAD (median absolute deviation)',
    category: 'Statistics',
    blurb: 'Robust spread measure — what dispersion looks like without outlier poisoning',
    related: ['robust-z', 'baselines'],
    body: Group(
      Para(
        Strong('MAD'),
        ' is a measure of how spread out a series of values is, computed as the median of the absolute deviations from the series median:',
      ),
      Para(Code('MAD = median(|xi − median(x)|)')),
      H('Why use it?'),
      Para(
        'MAD is the robust counterpart of standard deviation. Where stddev squares each deviation (so one extreme outlier balloons the result), MAD takes a median of deviations — a single 100× spike barely moves it. ',
        'For a Gaussian distribution, ',
        Code('stddev ≈ 1.4826 × MAD'),
        ', but insightd doesn\'t scale it: the raw MAD is what plugs into the robust z-score formula.',
      ),
      H('When it\'s null'),
      Para(
        'insightd skips MAD when the bucket has fewer than 10 samples — the estimate is too noisy to be useful below that. The Baselines viewer falls back to the percentile bars (min / p50 / p95 / max) as the visual.',
      ),
    ),
  },
  {
    id: 'baselines',
    title: 'Baselines',
    category: 'Baselines',
    blurb: 'Per-metric statistical reference computed from rolling history',
    related: ['time-of-day-buckets', 'robust-z', 'capacity-floor', 'anomaly-detection'],
    body: Group(
      Para(
        'A ', Strong('baseline'), ' is the statistical reference insightd builds for every (entity, metric, time-bucket) tuple. It captures what "normal" looks like over the last 14 days of data so detectors can ask "is this current value unusual?" instead of guessing at fixed thresholds.',
      ),
      H('What\'s in a baseline'),
      List([
        Group(Code('p50, p75, p90, p95, p99'), ' — percentiles of historical values'),
        Group(Code('min_val, max_val'), ' — observed extremes'),
        Group(Code('mad'), ' — median absolute deviation (the robust spread)'),
        Group(Code('sample_count'), ' — how many data points went in'),
      ]),
      H('When are they recomputed'),
      Para(
        'Baselines are rebuilt as part of the hourly insights cycle. Recent values shift the percentiles slowly; you won\'t see a baseline change on the time-scale of a single incident.',
      ),
      H('Where you see them'),
      List([
        'In the Baselines viewer (Explore drawer on host & container detail).',
        'Indirectly, in detector findings — most insights cite a baseline ("CPU 65% vs p95 of 22").',
        'Indirectly, in the Historical anomalies card, which uses MAD-based detection on rollups.',
      ]),
    ),
  },
  {
    id: 'time-of-day-buckets',
    title: 'Time-of-day buckets',
    category: 'Baselines',
    blurb: 'Six 4-hour periods + weekday/weekend + all-time, so "3am CPU" has its own baseline',
    related: ['baselines'],
    body: Group(
      Para(
        'insightd doesn\'t use one baseline per metric — it uses up to ', Strong('nine'),
        ', so detectors can ask "is this CPU level unusual ', Strong('for this time of day'),
        '?" instead of "for any time".',
      ),
      H('The buckets'),
      List([
        Group(Code('all'), ' — every recorded value (always present)'),
        Group(Code('weekday'), ' / ', Code('weekend'), ' — Monday–Friday vs Saturday–Sunday'),
        Group(Code('night'), ' (00–04), ',
              Code('early_morning'), ' (04–08), ',
              Code('morning'), ' (08–12), ',
              Code('afternoon'), ' (12–16), ',
              Code('evening'), ' (16–20), ',
              Code('late_evening'), ' (20–24)'),
      ]),
      H('Why bucket at all?'),
      Para(
        'Server load isn\'t evenly distributed. Backups run at 03:00, builds run during business hours, batch ETL runs late at night. ',
        'Without buckets, your "3am CPU baseline" includes 9am numbers, and the detector keeps shouting "CPU 80% — anomalous!" every time the nightly backup kicks off.',
      ),
      H('Sample threshold'),
      Para(
        'A bucket is only kept once it has 48+ samples (about a week of 5-minute snapshots). New entities will only have the ',
        Code('all'), ' bucket until enough data accumulates — the viewer says "time-of-day not yet learned" when this is the case.',
      ),
    ),
  },
  {
    id: 'capacity-floor',
    title: 'Capacity floor',
    category: 'Alerting',
    blurb: 'Hard absolute threshold an alert needs to clear before firing — even if baseline is exceeded',
    related: ['robust-z', 'baselines'],
    body: Group(
      Para(
        'Insightd\'s detectors use ',
        Strong('capacity-based thresholds'),
        ', not pure statistical deviation. Something can be way above its baseline ',
        Strong('and still not raise an alert'),
        ' if the absolute value is harmless.',
      ),
      H('Why?'),
      Para(
        'Imagine a host whose memory usage is normally 1.2%. One day it doubles to 2.4% — that\'s a 100% increase, several standard deviations above the baseline. ',
        'But 2.4% memory is fine. Pure deviation-based alerting would page someone at 3am for nothing. The capacity floor stops that.',
      ),
      H('Floors today'),
      List([
        Group(Strong('Host CPU'), ': must be sustained above ', Code('80%'), ' for 30+ minutes'),
        Group(Strong('Host memory'), ': must be sustained above ', Code('80% of total capacity')),
        Group(Strong('Host load_5'), ': must be sustained above ', Code('4')),
        Group(Strong('Container CPU'), ': must be above ', Code('50%'), ' AND above the p95 baseline'),
        Group(Strong('Container memory'), ': must be ', Code('p95 + 500 MB'), ' or higher'),
      ]),
      H('"Won\'t alert" pill'),
      Para(
        'The Baselines viewer shows a ', Code("won't alert"),
        ' pill when a metric is statistically high (above its p75 or p95) but still below the capacity floor. ',
        'It\'s a "yes, this looks unusual; no, you don\'t need to do anything" signal.',
      ),
    ),
  },
  {
    id: 'anomaly-detection',
    title: 'Historical anomaly detection',
    category: 'Detectors',
    blurb: 'How insightd identifies unusual spikes in past data — S-H-ESD on hourly rollups',
    related: ['robust-z', 'mad', 'baselines'],
    body: Group(
      Para(
        'The Historical anomalies card lists past spikes the detector found in your hourly rollups over the last 14 days. ',
        'These aren\'t live alerts — they\'re a backwards-looking record of "things that stood out".',
      ),
      H('How it works'),
      Para(
        'The detector runs ', Strong('S-H-ESD'), ' (Seasonal Hybrid Extreme Studentized Deviate) over each metric\'s hourly aggregates. ',
        'In practice, it\'s a robust-z-score test on residuals: it computes a series-wide median + MAD, then flags any hour whose value lies more than ',
        Code('z = 3'), ' away from the median.',
      ),
      H('Severity'),
      List([
        Group(Code('z 3–5'), ' — info'),
        Group(Code('z 5–10'), ' — warning'),
        Group(Code('z ≥ 10'), ' — critical'),
      ]),
      H('Why retrospective?'),
      Para(
        'Live alerts are about "what should I do right now?". Historical anomalies are about "what should I be aware of?". ',
        'A spike that already passed doesn\'t need an immediate response, but knowing it happened helps you understand whether your service is stable.',
      ),
    ),
  },
];

export const GLOSSARY: Map<string, GlossaryEntry> = new Map(ENTRIES.map(e => [e.id, e]));

export const GLOSSARY_BY_CATEGORY: { category: string; entries: GlossaryEntry[] }[] = (() => {
  const byCat = new Map<string, GlossaryEntry[]>();
  for (const e of ENTRIES) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category)!.push(e);
  }
  // Stable category order
  const order = ['Statistics', 'Baselines', 'Detectors', 'Alerting'];
  return order
    .filter(c => byCat.has(c))
    .map(category => ({ category, entries: byCat.get(category)!.sort((a, b) => a.title.localeCompare(b.title)) }));
})();
