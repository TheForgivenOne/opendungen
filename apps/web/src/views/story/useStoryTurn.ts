// Turn engine for the story view: streaming generation state plus the
// send/stop/retry/continue controls. Owns the draft, overlay, restore
// queue, and stream status; the screen keeps queries, scroll, drawer,
// and render. SSE state stays local (never in the query cache).

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, errorMessage } from "../../api/client";
import {
  streamContinue,
  streamGenerate,
  streamRetry,
  type AppliedRange,
  type GenerateMeta,
  type ScriptErrorInfo,
} from "../../api/generation";
import { type StoryAction } from "../../api/stories";
import {
  applyInputMode,
  readStoredInputMode,
  storeInputMode,
  type InputMode,
} from "../../input-mode";
import { type InputHistoryCursor } from "../../input-history";
import { useToast } from "../../toast";

export interface StoryTurnArgs {
  id: string;
  serverActions: StoryAction[];
  // Fired when a turn starts (the screen pins the reader to the bottom).
  onTurnStart?: () => void;
}

export function useStoryTurn({ id, serverActions, onTurnStart }: StoryTurnArgs) {
  const client = useQueryClient();
  const toast = useToast();

  const [draft, setDraft] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>(readStoredInputMode);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamError, setStreamError] = useState<{ code: string; message: string } | null>(null);
  const [contextInfo, setContextInfo] = useState<{ total: number; cards: number } | null>(null);
  const [appliedRanges, setAppliedRanges] = useState<AppliedRange[]>([]);
  const [restoreIds, setRestoreIds] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<StoryAction[]>([]);
  const [scriptNotices, setScriptNotices] = useState<ScriptErrorInfo[]>([]);
  // Ctrl+Up/Down history browsing (null = the user is typing fresh).
  const [historyCursor, setHistoryCursor] = useState<InputHistoryCursor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Optimistic inputs render until the server echo arrives; echoed ids
  // are filtered at render time and the overlay clears on every refresh.
  const serverIds = useMemo(() => new Set(serverActions.map((a) => a.id)), [serverActions]);
  const visibleOverlay = overlay.filter((a) => !serverIds.has(a.id));
  const actions = [...serverActions, ...visibleOverlay];

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function refreshActions() {
    setOverlay([]);
    await client.invalidateQueries({ queryKey: ["actions", id] });
  }

  async function refreshAfterDone() {
    await refreshActions();
    // Newly compressed ranges appear after the turn's tail runs.
    await client.invalidateQueries({ queryKey: ["ranges", id] });
  }

  function noteMeta(meta: GenerateMeta) {
    setContextInfo({ total: meta.usage.total, cards: meta.cardsInjected.length });
    setAppliedRanges(meta.rangesApplied ?? []);
  }

  async function runStream(kind: "generate" | "retry" | "continue", text?: string) {
    if (streaming) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setStreamText("");
    setStreamError(null);
    // A new turn pins the reader to the bottom.
    onTurnStart?.();
    // Restores are per-send: snapshot the queued ids for this turn.
    const restores = [...restoreIds];
    const sharedHandlers = {
      onDelta: (t: string) => setStreamText((prevText) => prevText + t),
      onDone: () => {
        void refreshAfterDone().catch((err: unknown) => toast.push("error", errorMessage(err)));
      },
      onError: (code: string, message: string) => {
        // Inline notice in the story column at the output position,
        // never a toast: the failure belongs to this turn.
        setStreamError({ code, message });
        void refreshActions();
      },
      onScriptErrors: (errors: ScriptErrorInfo[]) => {
        setScriptNotices(errors);
      },
    };
    try {
      if (kind === "continue") {
        // Continue is a real generation from context: no input
        // action, no optimistic overlay — the output streams in
        // place like any other output.
        await streamContinue(
          id,
          { onMeta: (meta) => noteMeta(meta), ...sharedHandlers },
          controller.signal,
          restores,
        );
      } else if (kind === "generate" && text !== undefined) {
        const inputText = text;
        const mode: InputMode = inputMode;
        // The client transforms before sending so the optimistic
        // overlay matches the persisted row exactly.
        const transformed = applyInputMode(inputText, mode);
        await streamGenerate(
          id,
          transformed,
          {
            onMeta: (meta) => {
              noteMeta(meta);
              if (!meta.inputActionId) {
                return;
              }
              const inputId = meta.inputActionId;
              const base = serverActions.length;
              setOverlay((prevOverlay) => [
                ...prevOverlay,
                {
                  id: inputId,
                  storyId: id,
                  idx: base + prevOverlay.length,
                  type: "input",
                  text: transformed,
                  mode,
                  createdAt: Date.now(),
                },
              ]);
            },
            ...sharedHandlers,
          },
          controller.signal,
          restores,
          mode,
        );
      } else {
        const lastId = actions.length ? actions[actions.length - 1].id : null;
        await streamRetry(
          id,
          {
            onMeta: (meta) => {
              noteMeta(meta);
              // The old output was deleted server-side; drop it locally.
              if (lastId) {
                setOverlay((prevOverlay) => prevOverlay.filter((a) => a.id !== lastId));
                client.setQueryData(["actions", id], (old: unknown) => {
                  if (!old || typeof old !== "object" || !("actions" in old)) {
                    return old;
                  }
                  const cached = old as { actions: StoryAction[] };
                  return { actions: cached.actions.filter((a) => a.id !== lastId) };
                });
              }
            },
            ...sharedHandlers,
          },
          controller.signal,
        );
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Stopped by the user: the persisted input (if any) stays.
        void refreshActions();
      } else if (err instanceof ApiError && err.status === 401) {
        // The global handler redirects to login; no inline error.
      } else {
        // Generation failures surface inline where the output would
        // have been — never as toasts. Toasts are for mutations.
        setStreamError({
          code: err instanceof ApiError ? err.code : "request_failed",
          message: errorMessage(err),
        });
        void refreshActions();
      }
    } finally {
      setStreaming(false);
      setStreamText("");
      abortRef.current = null;
    }
  }

  function send() {
    if (!draft.trim() || streaming) {
      return;
    }
    const text = draft.trim();
    setDraft("");
    void runStream("generate", text).finally(() => {
      // The restore list is per-send: always cleared after the send.
      setRestoreIds([]);
    });
  }

  function stop() {
    abortRef.current?.abort();
  }

  function retry() {
    setStreamError(null);
    void runStream("retry");
  }

  // Continue: the model keeps going with no new player input — a
  // real generation from context (POST /generate { continue: true }),
  // persisting only the output action.
  function cont() {
    if (streaming) {
      return;
    }
    setStreamError(null);
    void runStream("continue").finally(() => {
      setRestoreIds([]);
    });
  }

  function changeMode(mode: InputMode) {
    setInputMode(mode);
    storeInputMode(mode);
  }

  return {
    draft,
    setDraft,
    inputMode,
    streaming,
    streamText,
    streamError,
    setStreamError,
    contextInfo,
    appliedRanges,
    restoreIds,
    setRestoreIds,
    overlay,
    visibleOverlay,
    actions,
    scriptNotices,
    setScriptNotices,
    historyCursor,
    setHistoryCursor,
    inputRef,
    refreshActions,
    runStream,
    send,
    stop,
    retry,
    cont,
    changeMode,
  };
}
