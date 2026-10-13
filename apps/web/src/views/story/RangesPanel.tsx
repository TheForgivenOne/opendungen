// Compressed-ranges panel (story view drawer).

import { useState } from "react";
import { type CompressedRange } from "../../api/ranges";

export function RangesPanel({
  ranges,
  restoreIds,
  onRestore,
  onDelete,
}: {
  ranges: CompressedRange[] | null;
  restoreIds: string[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  function truncate(summary: string): string {
    return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
  }

  function renderRange(range: CompressedRange, depth: number, all: CompressedRange[]) {
    const children = all.filter((r) => r.parentRangeId === range.id);
    const restored = restoreIds.includes(range.id);
    return (
      <li key={range.id}>
        <div className="border-b border-border py-2 text-sm" style={{ marginLeft: depth * 16 }}>
          <div className="flex items-center justify-between gap-2">
            <span>
              [{range.startIdx}–{range.endIdx}] {truncate(range.summary)}{" "}
              {restored && <span className="font-mono text-xs text-accent">restoring</span>}
            </span>
            <div className="flex gap-3 font-mono text-xs">
              <button
                className="text-text-muted hover:text-text disabled:opacity-40"
                disabled={restored}
                onClick={() => onRestore(range.id)}
              >
                {restored ? "Restoring ✓" : "Restore this turn"}
              </button>
              <button
                className="text-text-muted hover:text-danger"
                onClick={() => onDelete(range.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        {children.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2">
            {children.map((child) => renderRange(child, depth + 1, all))}
          </ul>
        )}
      </li>
    );
  }

  const byId = new Map((ranges ?? []).map((r) => [r.id, r] as const));
  const roots = (ranges ?? []).filter((r) => !r.parentRangeId || !byId.has(r.parentRangeId));

  return (
    <div>
      <button
        className="flex w-full items-center justify-between py-2 text-left text-sm font-medium"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        Context ranges{ranges && ranges.length > 0 ? ` (${ranges.length})` : ""}
        <span className="text-text-muted">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="pb-2">
          {ranges === null ? (
            <p className="text-text-muted">loading…</p>
          ) : ranges.length === 0 ? (
            <p className="mb-3 text-sm text-text-muted">No compressed ranges yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {roots.map((root) => renderRange(root, 0, ranges))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
