// Story-view keyboard shortcuts. Kept in a hook with no DOM imports
// beyond types so the mapping is unit-testable:
//   Enter → send, Shift+Enter → newline (native)
//   Esc → abort streaming
//   Cmd/Ctrl+Z → undo last pair, Cmd/Ctrl+R → retry last output — both
//   hijacked only when the story view holds focus and the input is
//   empty (R would otherwise reload the page), and never while streaming.
//   Cmd/Ctrl+1/2/3 → input mode lives in the mode switcher itself.

import { useEffect, type KeyboardEvent, type RefObject } from "react";

export interface StoryShortcutHandlers {
  onSend: () => void;
  onStop: () => void;
  onUndo: () => void;
  onRetry: () => void;
}

export interface StoryShortcutState {
  streaming: boolean;
  inputEmpty: boolean;
  canModifyPair: boolean;
}

export function useStoryShortcuts(
  containerRef: RefObject<HTMLElement | null>,
  handlers: StoryShortcutHandlers,
  state: StoryShortcutState,
): {
  onInputKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
} {
  const { onSend, onStop, onUndo, onRetry } = handlers;
  const { streaming, inputEmpty, canModifyPair } = state;

  function onInputKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    } else if (e.key === "Escape" && streaming) {
      e.preventDefault();
      onStop();
    }
  }

  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent) {
      // Escape aborts at window level: the textarea is disabled while
      // streaming, so it has no focus to receive the key itself.
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (streaming && !e.defaultPrevented) {
          e.preventDefault();
          onStop();
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "r") {
        return;
      }
      // Only when the story view holds focus and the input is empty;
      // otherwise native undo / reload must win.
      const root = containerRef.current;
      if (!root || !root.contains(document.activeElement)) {
        return;
      }
      if (!inputEmpty || streaming || !canModifyPair) {
        return;
      }
      e.preventDefault();
      if (key === "z") {
        onUndo();
      } else {
        onRetry();
      }
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [containerRef, onStop, onUndo, onRetry, inputEmpty, streaming, canModifyPair]);

  return { onInputKeyDown };
}

export const SHORTCUTS = [
  { keys: "Enter", action: "Send" },
  { keys: "Shift+Enter", action: "New line" },
  { keys: "Esc", action: "Stop generating / close dialogs" },
  { keys: "Cmd/Ctrl+Z", action: "Undo last turn" },
  { keys: "Cmd/Ctrl+R", action: "Retry last turn (input must be empty)" },
  { keys: "Cmd/Ctrl+1/2/3", action: "Do / Say / Story input mode" },
  { keys: "Ctrl/Cmd+Up/Down", action: "Previous / next input" },
  { keys: "Cmd/Ctrl+K", action: "Command palette" },
];
