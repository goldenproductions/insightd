import type { ReactNode } from 'react';

interface Props {
  selectedCount: number;
  totalInView: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Action buttons rendered to the right of the selection summary. */
  actions: ReactNode;
}

/**
 * Compact toolbar that sits above a selectable table. Always rendered when the
 * table has any rows so the "Select all in view" affordance is always reachable;
 * the action buttons only become useful when at least one row is selected.
 */
export function AlertBulkToolbar({ selectedCount, totalInView, allSelected, onSelectAll, onClearSelection, actions }: Props) {
  const hasSelection = selectedCount > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-light px-4 py-2 text-xs">
      <label className="flex items-center gap-2 text-muted">
        <input
          type="checkbox"
          checked={allSelected && totalInView > 0}
          onChange={onSelectAll}
          aria-label="Select all in view"
          className="cursor-pointer"
        />
        <span>Select all in view</span>
      </label>

      {hasSelection ? (
        <>
          <span className="font-medium text-fg">{selectedCount} selected</span>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
          <button
            type="button"
            onClick={onClearSelection}
            className="ml-auto text-muted hover:text-fg"
          >
            Clear selection
          </button>
        </>
      ) : (
        <span className="text-muted">{totalInView} in view</span>
      )}
    </div>
  );
}
