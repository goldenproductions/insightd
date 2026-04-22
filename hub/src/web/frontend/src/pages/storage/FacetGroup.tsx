export interface FacetItem {
  id: string;
  label: string;
  count: number;
}

export function FacetGroup({
  title, items, selected, onToggle, single = false,
}: {
  title: string;
  items: FacetItem[];
  selected: string[];
  onToggle: (id: string) => void;
  single?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <ul className="space-y-1.5">
        {items.map(it => {
          const on = selected.includes(it.id);
          return (
            <li key={it.id}>
              <label className="group flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={single ? title : undefined}
                  checked={on}
                  onChange={() => onToggle(it.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                />
                <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium text-fg' : 'text-secondary group-hover:text-fg'}`}>
                  {it.label}
                </span>
                <span className="text-[11px] tabular-nums text-muted">{it.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
