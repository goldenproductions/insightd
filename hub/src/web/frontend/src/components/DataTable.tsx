import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  accessor: (row: T) => ReactNode;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  emptyText?: string;
}

export function DataTable<T>({ columns, data, onRowClick, emptyText = 'No data' }: Props<T>) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>{emptyText}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {columns.map((col, i) => (
              <th key={i} className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide ${col.className || ''}`}
                style={{ color: 'var(--text-muted)' }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'cursor-pointer transition-colors' : ''}
              style={{ borderBottom: '1px solid var(--border-light)' }}
              onMouseEnter={e => { if (onRowClick) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-hover)'; }}
              onMouseLeave={e => { if (onRowClick) (e.currentTarget as HTMLElement).style.backgroundColor = ''; }}
            >
              {columns.map((col, j) => (
                <td key={j} className={`px-3 py-2.5 ${col.className || ''}`} style={{ color: 'var(--text)' }}>
                  {col.accessor(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
