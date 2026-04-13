import type { ReactNode, KeyboardEvent } from 'react';

export interface Column<T> {
  header: string;
  accessor: (row: T) => ReactNode;
  className?: string;
  /** Hide this column below sm breakpoint on mobile */
  hideOnMobile?: boolean;
  /** Optional native title= tooltip on the column header */
  headerTooltip?: string;
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

  const handleKeyDown = (e: KeyboardEvent, row: T) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col, i) => (
              <th key={i} scope="col" title={col.headerTooltip} className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted ${col.hideOnMobile ? 'hidden sm:table-cell' : ''} ${col.className || ''}`}>
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
              onKeyDown={onRowClick ? (e) => handleKeyDown(e, row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              className={`border-b border-border-light ${onRowClick ? 'cursor-pointer hover-surface focus-visible:bg-surface-hover' : ''}`}
            >
              {columns.map((col, j) => (
                <td key={j} className={`px-3 py-2.5 text-fg ${col.hideOnMobile ? 'hidden sm:table-cell' : ''} ${col.className || ''}`}>
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
