// Story action rendering: player marker, in-place editor, action view,
// and the inline generation-error notice.

import { useEffect, useRef, useState } from "react";
import { type ActionMode, type StoryAction } from "../../api/stories";

// Quiet › marker + mode tag for player (do/say) actions. The tag shows
// on hover or while the action is fresh (<2s old); the marker is
// always visible but unobtrusive.
function PlayerMarker({ mode, createdAt }: { mode: ActionMode; createdAt: number }) {
  const [fresh, setFresh] = useState(() => Date.now() - createdAt < 2000);
  useEffect(() => {
    if (!fresh) {
      return;
    }
    const timer = window.setTimeout(() => setFresh(false), 2000);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  return (
    <span className="mr-2 inline-flex select-none items-baseline gap-1.5" aria-hidden="true">
      <span className="text-accent">›</span>
      <span
        className={`text-[10px] uppercase tracking-widest text-text-muted ${
          fresh ? "" : "hidden group-hover/action:inline"
        }`}
      >
        {mode.toUpperCase()}
      </span>
    </span>
  );
}

function ActionEditor({
  action,
  onSave,
  onCancel,
}: {
  action: StoryAction;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const committed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.textContent = action.text;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    el.focus();
  }, [action.id, action.text]);

  function commit() {
    if (committed.current) {
      return;
    }
    committed.current = true;
    const text = (ref.current?.textContent ?? "").trim();
    // Empty edits are ignored (the old text stays).
    onSave(text || action.text);
  }

  function cancel() {
    committed.current = true;
    onCancel();
  }

  return (
    <div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Edit action"
        className="min-w-0 outline-none"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            // Enter commits, Esc cancels, Cmd/Ctrl+Enter commits.
            // (Shift+Enter inserts a newline via the browser default.)
            e.preventDefault();
            commit();
          }
        }}
        // Clicking outside commits. Cancel uses onMouseDown +
        // preventDefault so it runs before blur.
        onBlur={commit}
      />
      <div className="mt-1 flex gap-2 font-mono text-xs text-text-muted">
        <button
          className="hover:text-text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          Save
        </button>
        <span aria-hidden="true">·</span>
        <button
          className="hover:text-text"
          onMouseDown={(e) => e.preventDefault()}
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ActionView({
  action,
  editing,
  editDisabled,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  action: StoryAction;
  editing: boolean;
  editDisabled: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
}) {
  // Player do/say lines: mono, addressed at the margin. Everything
  // else (story-mode inputs, AI outputs) is serif prose indented by
  // 1.5rem — distinguishable by position and type, never by color.
  const isPlayer = action.type === "input" && (action.mode === "do" || action.mode === "say");
  return (
    <div
      className={`action group/action mb-5 ${isPlayer ? "" : "pl-6"}`}
      data-action-id={action.id}
      data-action-type={action.type}
    >
      {editing ? (
        <div className={isPlayer ? "font-mono text-[15px] leading-relaxed" : ""}>
          <ActionEditor action={action} onSave={onSaveEdit} onCancel={onCancelEdit} />
        </div>
      ) : (
        <div
          className={isPlayer ? "font-mono text-[15px] leading-relaxed" : ""}
          onClick={() => {
            if (!editDisabled) {
              onStartEdit();
            }
          }}
          role={editDisabled ? undefined : "button"}
          aria-label={editDisabled ? undefined : "Edit action"}
        >
          {isPlayer && (
            <PlayerMarker mode={action.mode as ActionMode} createdAt={action.createdAt} />
          )}
          <span className="whitespace-pre-wrap">{action.text}</span>
        </div>
      )}
    </div>
  );
}

// Inline generation failure (Phase 6b): rendered in the story column
// at the position where the output would have been. 13px sans muted,
// no background, 1.5rem indent matching AI output. Retry regenerates
// (lone input) or the last output; Edit input opens the input above
// in place. Never a toast.
export function InlineGenerationError({
  message,
  onRetry,
  onEditInput,
  hasInput,
}: {
  message: string;
  onRetry: () => void;
  onEditInput: () => void;
  hasInput: boolean;
}) {
  return (
    <div className="mb-5 pl-6" role="alert">
      <p className="text-[13px] text-text-muted">
        Generation failed: {message}{" "}
        <button className="font-mono text-[13px] text-accent hover:underline" onClick={onRetry}>
          Retry
        </button>
        {hasInput && (
          <>
            <span aria-hidden="true"> · </span>
            <button
              className="font-mono text-[13px] text-accent hover:underline"
              onClick={onEditInput}
            >
              Edit input
            </button>
          </>
        )}
      </p>
    </div>
  );
}
