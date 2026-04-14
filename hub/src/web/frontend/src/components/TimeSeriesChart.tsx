import { useEffect, useMemo, useRef, useState, memo } from 'react';
import UplotReact from 'uplot-react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** CSS color (hex or `var(--color-...)`) used for line + area fill. */
  color: string;
  /** Optional formatter for tick + hover values. Falls back to niceNumber + unit. */
  formatValue?: (v: number) => string;
}

interface TimeSeriesChartProps {
  /** Unix seconds, monotonically increasing. */
  timestamps: number[];
  series: ChartSeries[];
  title?: string;
  /** Y-axis unit label when no per-series formatValue. */
  unit?: string;
  /** Chart body height in px. Default 180. */
  height?: number;
}

function niceNumber(v: number, unit = ''): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${Math.round(v)}${unit}`;
  if (abs >= 100) return `${v.toFixed(0)}${unit}`;
  if (abs >= 10) return `${v.toFixed(1)}${unit}`;
  return `${v.toFixed(2)}${unit}`;
}

function hexToRgba(hex: string, alpha: number): string | null {
  if (!hex || !hex.startsWith('#')) return null;
  const m = hex.length === 4
    ? hex.slice(1).split('').map((c) => c + c).join('')
    : hex.slice(1);
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Resolve a color that may be a var(--...) reference against the DOM. */
function resolveColor(color: string): string {
  if (typeof window === 'undefined') return color;
  if (!color.startsWith('var(')) return color;
  const name = color.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolved || color;
}

export const TimeSeriesChart = memo(function TimeSeriesChart({
  timestamps,
  series,
  title,
  unit = '',
  height = 180,
}: TimeSeriesChartProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) setWidth(w);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const data = useMemo<uPlot.AlignedData>(() => {
    return [timestamps, ...series.map((s) => s.values as (number | null)[])] as uPlot.AlignedData;
  }, [timestamps, series]);

  const options = useMemo<uPlot.Options>(() => {
    const resolvedSeries: uPlot.Series[] = [
      {},
      ...series.map((s) => {
        const color = resolveColor(s.color);
        const fill = hexToRgba(color, 0.12) ?? `${color}22`;
        return {
          label: s.label,
          stroke: color,
          width: 1.75,
          fill,
          points: { show: false },
          value: (_u: uPlot, v: number | null) =>
            v == null ? '—' : s.formatValue ? s.formatValue(v) : niceNumber(v, unit),
        } as uPlot.Series;
      }),
    ];

    const gridColor = resolveColor('var(--color-border)');
    const textColor = resolveColor('var(--color-muted)');

    return {
      width,
      height,
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      padding: [12, 14, 4, 4],
      cursor: {
        drag: { x: false, y: false },
        points: { size: 8, width: 2 },
      },
      legend: { show: true, live: true },
      axes: [
        {
          stroke: textColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1 },
          font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          space: 60,
        },
        {
          stroke: textColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: gridColor, width: 1 },
          font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          size: 48,
          values: (_u, ticks) =>
            ticks.map((t) => {
              const first = series[0];
              if (first?.formatValue) return first.formatValue(t);
              return niceNumber(t, unit);
            }),
        },
      ],
      series: resolvedSeries,
    };
  }, [series, width, height, unit]);

  return (
    <div>
      {title && (
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h3>
      )}
      <div ref={wrapperRef} className="uplot-wrapper rounded-lg bg-surface">
        <UplotReact options={options} data={data} />
      </div>
    </div>
  );
});
