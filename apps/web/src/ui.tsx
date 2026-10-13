// Shared presentational bits: semantic-token classes, skeletons, modal,
// relative time. Colors come only from the tokens defined in index.css
// (bg, surface, border, text, text-text-muted, primary, danger).

import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded border border-border bg-surface px-3 py-2 text-text placeholder:text-text-muted";
export const buttonClass =
  "rounded bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90 disabled:opacity-50";
export const ghostClass =
  "rounded border border-border px-3 py-1 text-sm text-text hover:bg-surface-hover disabled:opacity-50";
export const cardClass = "mx-auto w-full max-w-xl rounded border border-border bg-surface p-6";

export function ErrorText({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return <p className="text-sm text-danger">{error}</p>;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-label="loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-12 animate-pulse rounded border border-border bg-surface" />
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onClose();
          }
        }}
        role="presentation"
      />
      <div className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className={ghostClass} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function formatTokens(total: number): string {
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
}

export function formatRelative(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Must match DEFAULT_CONTEXT_BUDGET.totalTokens in packages/shared/src/story.ts.
export const CONTEXT_BUDGET_TOKENS = 8192;

export function ScenarioTag({ tag }: { tag: string }) {
  return <span className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">{tag}</span>;
}
