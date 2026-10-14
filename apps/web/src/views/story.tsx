// Story view: a continuous text column, not chat. No
// bubbles, cards, or per-row buttons — narrative in serif, player
// input in mono with a quiet › marker, chrome (header) collapsing on
// scroll, and all settings behind a right-hand drawer. SSE state stays
// local; server reads go through react-query.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage } from "../api/client";
import { editAction, undoTurn } from "../api/generation";
import { historyNext, historyPrev } from "../input-history";
import { navigate } from "../location";
import { useDeleteRange, useProviders, useRanges, useStory, useStoryActions } from "../queries";
import { useStoryShortcuts } from "../shortcuts";
import { useToast } from "../toast";
import { ErrorText, Skeleton, buttonClass } from "../ui";
import { ActionView, InlineGenerationError } from "./story/ActionList";
import { EFFECTIVE_DEFAULTS } from "./story/DrawerPanels";
import { SettingsDrawer } from "./story/SettingsDrawer";
import { StoryFooter } from "./story/StoryFooter";
import { StoryHeader } from "./story/StoryHeader";
import { useStoryScroll } from "./story/useStoryScroll";
import { useStoryTurn } from "./story/useStoryTurn";

export function StoryScreen({ id }: { id: string }) {
  const toast = useToast();
  const storyQuery = useStory(id);
  const actionsQuery = useStoryActions(id);
  const providersQuery = useProviders();
  const rangesQuery = useRanges(id);
  const deleteRange = useDeleteRange(id);

  const story = storyQuery.data?.story ?? null;
  const serverActions = useMemo(() => actionsQuery.data?.actions ?? [], [actionsQuery.data]);
  const providers = providersQuery.data?.providers ?? null;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSection, setDrawerSection] = useState<string | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef<() => void>(() => {});

  const turn = useStoryTurn({
    id,
    serverActions,
    // Latest scroll pin: assigned below once the scroll hook exists.
    onTurnStart: () => pinRef.current(),
  });

  const actions = turn.actions;
  const last = actions[actions.length - 1];
  const prev = actions[actions.length - 2];
  const lastPair =
    last && last.type === "output" && prev && prev.type === "input"
      ? { inputId: prev.id, outputId: last.id }
      : null;

  // Newest input action: the inline error's Edit input target.
  let lastInputId: string | null = null;
  for (let i = actions.length - 1; i >= 0; i--) {
    const candidate = actions[i];
    if (candidate?.type === "input") {
      lastInputId = candidate.id;
      break;
    }
  }

  function editLastInput() {
    if (lastInputId) {
      setEditingId(lastInputId);
    }
  }

  const scroll = useStoryScroll({
    scrollRef,
    inputRef: turn.inputRef,
    storyId: id,
    storyReady: storyQuery.isSuccess,
    actionsReady: actionsQuery.isSuccess,
    streamText: turn.streamText,
    visibleOverlayLength: turn.visibleOverlay.length,
  });
  const { atBottom, headerCollapsed, onScroll, scrollToBottom } = scroll;
  // Latest scroll pin for turn starts (ref: the turn hook reads it
  // in callbacks; assignment in an effect, never during render).
  useEffect(() => {
    pinRef.current = scroll.pinToBottom;
  });

  // Command palette script entries open the drawer at Scripts.
  useEffect(() => {
    function onOpenDrawer(e: Event) {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section ?? null;
      setDrawerSection(section);
      setDrawerOpen(true);
    }
    window.addEventListener("opendungen:open-drawer", onOpenDrawer);
    return () => window.removeEventListener("opendungen:open-drawer", onOpenDrawer);
  }, []);

  const defaultProvider = providers?.find((p) => p.isDefault) ?? null;
  // Effective provider: the story's persistent override wins, else the
  // default. Generation works whenever either exists.
  const overrideProvider = story?.providerId
    ? (providers?.find((p) => p.id === story.providerId) ?? null)
    : null;
  const effectiveProvider = overrideProvider ?? defaultProvider;
  const effectiveBudget = story?.contextTokens ?? EFFECTIVE_DEFAULTS.contextTokens;

  async function undo() {
    if (turn.streaming) {
      return;
    }
    try {
      await undoTurn(id);
      await turn.refreshActions();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  async function saveEdit(actionId: string, text: string) {
    if (!text.trim() || turn.streaming) {
      return;
    }
    try {
      await editAction(id, actionId, text.trim());
      setEditingId(null);
      await turn.refreshActions();
    } catch (err) {
      toast.push("error", errorMessage(err));
    }
  }

  function removeRange(rangeId: string) {
    if (!window.confirm("Delete this range? The underlying actions stay intact.")) {
      return;
    }
    deleteRange.mutate(rangeId, {
      onSuccess: () => turn.setRestoreIds((prev) => prev.filter((r) => r !== rangeId)),
    });
  }

  const { onInputKeyDown } = useStoryShortcuts(
    containerRef,
    {
      onSend: turn.send,
      onStop: turn.stop,
      onUndo: () => void undo(),
      onRetry: turn.retry,
    },
    {
      streaming: turn.streaming,
      inputEmpty: turn.draft === "",
      canModifyPair: lastPair !== null,
    },
  );

  // The last 50 input actions, oldest first, for history browsing.
  const inputHistory = actions
    .filter((a) => a.type === "input")
    .map((a) => a.text)
    .slice(-50);

  function onTextareaKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = historyPrev(inputHistory, turn.historyCursor, turn.draft);
        turn.setHistoryCursor(next.cursor);
        turn.setDraft(next.text);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = historyNext(inputHistory, turn.historyCursor);
        if (next.text !== null) {
          turn.setHistoryCursor(next.cursor);
          turn.setDraft(next.text);
        }
        return;
      }
    }
    onInputKeyDown(e);
  }

  if (storyQuery.isPending) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <Skeleton lines={6} />
      </div>
    );
  }

  if (storyQuery.isError || !story) {
    return (
      <div className="mx-auto w-full max-w-xl p-4">
        <ErrorText error={storyQuery.isError ? errorMessage(storyQuery.error) : "not found"} />
        <button
          className="mt-3 font-mono text-xs text-text-muted hover:text-text"
          onClick={() => navigate("/stories")}
        >
          ← Stories
        </button>
      </div>
    );
  }

  const streamingActive = turn.streaming && !turn.streamError;

  return (
    <article ref={containerRef} className="flex h-dvh flex-col bg-bg text-text">
      <StoryHeader
        story={story}
        effectiveProvider={effectiveProvider}
        overrideProvider={overrideProvider}
        contextInfo={turn.contextInfo}
        appliedRanges={turn.appliedRanges}
        effectiveBudget={effectiveBudget}
        headerCollapsed={headerCollapsed}
        onOpenSettings={() => {
          setDrawerSection(null);
          setDrawerOpen(true);
        }}
      />

      {providers !== null && providers.length === 0 && (
        <div className="shrink-0 border-b border-border bg-surface px-4 py-2" role="note">
          <div className="mx-auto flex w-full max-w-[680px] items-center gap-3">
            <p className="flex-1 text-sm text-text-muted">Connect a provider to start playing</p>
            <button className={buttonClass} onClick={() => navigate("/providers")}>
              Set up
            </button>
          </div>
        </div>
      )}

      <main
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
        aria-label="Story"
      >
        <div
          className="pointer-events-none sticky top-0 z-10 h-6 bg-gradient-to-b from-bg to-transparent transition-opacity"
          style={{ opacity: scroll.scrollTop > 0 ? 1 : 0 }}
          aria-hidden="true"
        />
        <div className="story-column story-prose mx-auto w-full px-4 pb-[120px]">
          {actionsQuery.isPending ? (
            <Skeleton lines={4} />
          ) : actions.length === 0 && !streamingActive && !turn.streamError ? (
            <p className="pl-6 text-text-muted">The story begins. What happens next?</p>
          ) : (
            actions.map((action) => (
              <ActionView
                key={action.id}
                action={action}
                editing={editingId === action.id}
                editDisabled={turn.streaming && action.id === last?.id && action.type !== "input"}
                onStartEdit={() => setEditingId(action.id)}
                onSaveEdit={(text) => void saveEdit(action.id, text)}
                onCancelEdit={() => setEditingId(null)}
              />
            ))
          )}
          {streamingActive && (
            <div className="stream-caret mb-5 pl-6" aria-live="polite">
              <span className="whitespace-pre-wrap">{turn.streamText}</span>
            </div>
          )}
          {turn.streamError && (
            <InlineGenerationError
              message={turn.streamError.message}
              onRetry={turn.retry}
              onEditInput={editLastInput}
              hasInput={lastInputId !== null}
            />
          )}
        </div>
        {!atBottom && (
          <button
            className="absolute bottom-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-text-muted hover:text-text"
            onClick={scrollToBottom}
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            ↓
          </button>
        )}
      </main>

      <StoryFooter
        restoreIds={turn.restoreIds}
        streaming={turn.streaming}
        lastPair={lastPair}
        cont={turn.cont}
        retry={turn.retry}
        undo={() => void undo()}
        send={turn.send}
        stop={turn.stop}
        draft={turn.draft}
        setDraft={turn.setDraft}
        setHistoryCursor={turn.setHistoryCursor}
        inputRef={turn.inputRef}
        inputMode={turn.inputMode}
        changeMode={turn.changeMode}
        onTextareaKeyDown={onTextareaKeyDown}
        effectiveProvider={effectiveProvider}
        providers={providers}
      />

      {turn.scriptNotices.length > 0 && (
        <div className="fixed bottom-2 left-2 z-30 max-w-xs border border-border bg-surface p-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium">Script notices</span>
            <button
              className="font-mono text-xs text-text-muted hover:text-text"
              onClick={() => turn.setScriptNotices([])}
            >
              Dismiss
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            {turn.scriptNotices.map((notice) => (
              <li key={`${notice.scriptId}:${notice.message}`}>
                {notice.name}: {notice.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {drawerOpen && (
        <SettingsDrawer
          story={story}
          actionCount={actions.length}
          providers={providers}
          ranges={rangesQuery.data?.ranges ?? null}
          restoreIds={turn.restoreIds}
          onRestore={(rangeId) =>
            turn.setRestoreIds((prev) => (prev.includes(rangeId) ? prev : [...prev, rangeId]))
          }
          onDeleteRange={removeRange}
          onClose={() => setDrawerOpen(false)}
          initialSection={drawerSection}
        />
      )}
    </article>
  );
}
