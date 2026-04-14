import { useState, useMemo, memo } from 'react';
import { Link } from 'react-router-dom';
import type { TimelineEntry } from '@/types/api';

interface Props {
  containers: TimelineEntry[];
  hostId?: string;
  days?: number;
  /** Override the start of the first slot. Defaults to `days * 24h` ago. */
  startMs?: number;
}

interface HoverState {
  rowIndex: number;
  slotIndex: number;
  clientX: number;
  clientY: number;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return `${start.toLocaleString(undefined, opts)} → ${end.toLocaleString(undefined, opts)}`;
}

function slotLabel(slot: string): string {
  if (slot === 'up') return 'Running';
  if (slot === 'down') return 'Stopped';
  return 'No data';
}

export const UptimeTimeline = memo(function UptimeTimeline({ containers, hostId, days = 7, startMs: startMsProp }: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);

  // Fix `startMs` at mount so hover hints don't drift while the component
  // sits open — real-data refreshes come from re-renders with new props.
  const startMs = useMemo(() => startMsProp ?? (Date.now() - days * 86400000), [startMsProp, days]);

  if (containers.length === 0) return null;

  // Longest row determines the total slot count so day markers align.
  const maxSlots = containers.reduce((n, c) => Math.max(n, c.slots.length), 0);
  if (maxSlots === 0) return null;
  const slotDurationMs = (days * 86400000) / maxSlots;

  // Build day label segments. Each segment spans from one midnight to the next
  // (or partial spans at the start/end). The label sits at the segment's center
  // and is the day name of that center — unambiguous regardless of how the
  // window aligns with local midnight.
  const endMs = startMs + days * 86400000;
  const firstMidnight = new Date(startMs);
  firstMidnight.setHours(24, 0, 0, 0);
  const boundaries: number[] = [startMs];
  for (let t = firstMidnight.getTime(); t < endMs; t += 86400000) boundaries.push(t);
  boundaries.push(endMs);

  const dayBoundaryFractions: number[] = [];
  const daySegments: { fraction: number; label: string; widthFraction: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i]!;
    const segEnd = boundaries[i + 1]!;
    const centerMs = (segStart + segEnd) / 2;
    const fraction = (centerMs - startMs) / (days * 86400000);
    const widthFraction = (segEnd - segStart) / (days * 86400000);
    daySegments.push({
      fraction,
      label: DAY_LABELS[new Date(centerMs).getDay()]!,
      widthFraction,
    });
    // Boundary for the vertical divider — only the ones strictly inside (0,1).
    if (i > 0) {
      const boundaryFraction = (segStart - startMs) / (days * 86400000);
      if (boundaryFraction > 0 && boundaryFraction < 1) dayBoundaryFractions.push(boundaryFraction);
    }
  }

  // Hide labels for segments too narrow to fit a 3-letter day name (~24px).
  const MIN_WIDTH_FRACTION_FOR_LABEL = 24 / 600; // rough lower bound

  const hoveredSlot = hover
    ? {
        row: containers[hover.rowIndex]!,
        slot: containers[hover.rowIndex]!.slots[hover.slotIndex],
        start: new Date(startMs + hover.slotIndex * slotDurationMs),
        end: new Date(startMs + (hover.slotIndex + 1) * slotDurationMs),
      }
    : null;

  return (
    <div className="relative">
      <div className="space-y-1.5">
        {containers.map((c, rowIndex) => {
          const rowBar = (
            <div
              className={`flex items-center gap-3 ${hostId ? 'cursor-pointer rounded-lg px-1 -mx-1 hover-surface' : ''}`}
            >
              <span className="w-28 truncate text-xs font-medium text-secondary">{c.name}</span>
              <div className="relative flex-1" onMouseLeave={() => setHover((h) => (h?.rowIndex === rowIndex ? null : h))}>
                {/* Day boundary verticals — sit behind the slots. */}
                <div className="pointer-events-none absolute inset-0">
                  {dayBoundaryFractions.map((fraction) => (
                    <div
                      key={`d-${fraction}`}
                      className="absolute top-0 bottom-0 w-px bg-border"
                      style={{ left: `${fraction * 100}%` }}
                    />
                  ))}
                </div>
                {/* Slot row — slightly taller than before for better hit-testing. */}
                <div className="relative flex h-[18px] gap-px">
                  {c.slots.map((slot, i) => {
                    const active = hover?.rowIndex === rowIndex && hover?.slotIndex === i;
                    const color = slot === 'up'
                      ? 'bg-[var(--color-success)]'
                      : slot === 'down'
                      ? 'bg-[var(--color-danger)]'
                      : 'bg-[var(--color-border)]';
                    const opacity = slot === 'none' ? 'opacity-40' : '';
                    return (
                      <div
                        key={i}
                        className={`flex-1 first:rounded-l-sm last:rounded-r-sm transition-[filter] ${color} ${opacity} ${active ? 'brightness-125' : ''}`}
                        onMouseEnter={(e) => setHover({ rowIndex, slotIndex: i, clientX: e.clientX, clientY: e.clientY })}
                        onMouseMove={(e) => {
                          if (hover?.rowIndex === rowIndex && hover?.slotIndex === i) return;
                          setHover({ rowIndex, slotIndex: i, clientX: e.clientX, clientY: e.clientY });
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <span className={`w-12 text-right text-xs font-semibold tabular-nums ${
                c.uptimePercent == null ? 'text-muted'
                  : c.uptimePercent >= 99 ? 'text-success'
                  : c.uptimePercent >= 95 ? 'text-warning'
                  : 'text-danger'
              }`}>
                {c.uptimePercent != null ? `${c.uptimePercent}%` : '—'}
              </span>
            </div>
          );

          if (hostId) {
            return (
              <Link key={c.name} to={`/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(c.name)}`} className="block">
                {rowBar}
              </Link>
            );
          }
          return <div key={c.name}>{rowBar}</div>;
        })}
      </div>

      {/* Day labels underneath, centered inside each day-segment. The slot row
          is laid out as: name col 112px + gap 12px + flex bar + gap 12px + suffix col 48px. */}
      <div className="relative mt-1 h-4 pl-[124px] pr-[60px] text-[10px] font-medium uppercase tracking-wide text-muted">
        <div className="relative h-full">
          {daySegments.map((seg, idx) =>
            seg.widthFraction >= MIN_WIDTH_FRACTION_FOR_LABEL ? (
              <span
                key={`lbl-${idx}`}
                className="absolute top-0"
                style={{ left: `${seg.fraction * 100}%`, transform: 'translateX(-50%)' }}
              >
                {seg.label}
              </span>
            ) : null,
          )}
        </div>
      </div>

      {/* Hover tooltip — rendered once per timeline, positioned at the cursor. */}
      {hoveredSlot && hoveredSlot.slot && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{
            left: (hover?.clientX ?? 0) + 12,
            top: (hover?.clientY ?? 0) + 14,
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-fg">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background:
                  hoveredSlot.slot === 'up' ? 'var(--color-success)'
                  : hoveredSlot.slot === 'down' ? 'var(--color-danger)'
                  : 'var(--color-muted)',
              }}
              aria-hidden="true"
            />
            {slotLabel(hoveredSlot.slot)}
          </div>
          <div className="mt-0.5 text-muted">{fmtRange(hoveredSlot.start, hoveredSlot.end)}</div>
          <div className="mt-0.5 text-muted">{hoveredSlot.row.name}</div>
        </div>
      )}
    </div>
  );
});
