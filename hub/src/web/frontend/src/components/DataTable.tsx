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
    return <p className="py-8 text-center text-sm text-muted">{emptyText}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col, i) => (
              <th key={i} scope="col" className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted ${col.className || ''}`}>
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
              className={`border-b border-border-light ${onRowClick ? 'cursor-pointer hover-surface' : ''}`}
            >
              {columns.map((col, j) => (
                <td key={j} className={`px-3 py-2.5 text-fg ${col.className || ''}`}>
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
