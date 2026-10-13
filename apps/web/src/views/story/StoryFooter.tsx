// Story footer: turn controls above the input, mode switcher and
// Send/Stop below. Sticky; the eye path is text -> actions -> input.

import {
  useEffect,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { type Provider } from "../../api/providers";
import { INPUT_MODES, placeholderForMode, type InputMode } from "../../input-mode";
import { type InputHistoryCursor } from "../../input-history";
import { navigate } from "../../location";
import { buttonClass, inputClass } from "../../ui";

function InputModeSwitcher({
  mode,
  onChange,
  disabled,
}: {
  mode: InputMode;
  onChange: (mode: InputMode) => void;
  disabled: boolean;
}) {
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) {
        return;
      }
      if (e.key !== "1" && e.key !== "2" && e.key !== "3") {
        return;
      }
      const next = INPUT_MODES[Number(e.key) - 1];
      if (next && !disabled) {
        e.preventDefault();
        onChange(next.value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChange, disabled]);

  return (
    <div className="flex gap-1 font-mono text-xs flex-wrap" role="group" aria-label="Input mode">
      {INPUT_MODES.map((item, i) => (
        <button
          key={item.value}
          type="button"
          disabled={disabled}
          aria-pressed={mode === item.value}
          title={`${item.label} (⌘${i + 1})`}
          onClick={() => onChange(item.value)}
          className={`rounded px-2 py-1 ${
            mode === item.value ? "bg-surface-hover text-accent" : "text-text-muted hover:text-text"
          } disabled:opacity-40`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export interface StoryFooterProps {
  restoreIds: string[];
  streaming: boolean;
  lastPair: { inputId: string; outputId: string } | null;
  cont: () => void;
  retry: () => void;
  undo: () => void;
  send: () => void;
  stop: () => void;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  setHistoryCursor: Dispatch<SetStateAction<InputHistoryCursor | null>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputMode: InputMode;
  changeMode: (mode: InputMode) => void;
  onTextareaKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  effectiveProvider: Provider | null;
  providers: Provider[] | null;
}

export function StoryFooter({
  restoreIds,
  streaming,
  lastPair,
  cont,
  retry,
  undo,
  send,
  stop,
  draft,
  setDraft,
  setHistoryCursor,
  inputRef,
  inputMode,
  changeMode,
  onTextareaKeyDown,
  effectiveProvider,
  providers,
}: StoryFooterProps) {
  return (
    <footer className="sticky bottom-0 shrink-0 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto w-full max-w-[680px] px-4 py-3">
        {restoreIds.length > 0 && (
          <div className="mb-2">
            <span className="rounded bg-accent/10 px-2 py-1 font-mono text-xs text-accent">
              restoring {restoreIds.length} range{restoreIds.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        <div className="flex items-center justify-end" aria-label="Turn controls">
          <button
            className="quiet-control quiet-control-primary hidden min-[480px]:inline"
            disabled={streaming}
            onClick={cont}
          >
            Continue
          </button>
          <span className="hidden text-text-muted min-[480px]:inline" aria-hidden="true">
            ·
          </span>
          <button
            className="quiet-control"
            disabled={streaming || lastPair === null}
            onClick={retry}
          >
            Retry
          </button>
          <span className="text-text-muted" aria-hidden="true">
            ·
          </span>
          <button
            className="quiet-control"
            disabled={streaming || lastPair === null}
            onClick={() => void undo()}
          >
            Undo
          </button>
        </div>
        <form
          className="mt-2 flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (streaming) {
              stop();
            } else {
              send();
            }
          }}
        >
          <textarea
            ref={inputRef}
            className={`${inputClass} max-h-40 font-mono !text-[15px]`}
            rows={2}
            placeholder={placeholderForMode(inputMode)}
            aria-label={placeholderForMode(inputMode)}
            value={draft}
            disabled={streaming}
            onChange={(e) => {
              setDraft(e.target.value);
              setHistoryCursor(null);
            }}
            onKeyDown={onTextareaKeyDown}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <InputModeSwitcher mode={inputMode} onChange={changeMode} disabled={streaming} />
            {streaming ? (
              <button type="submit" className={buttonClass} aria-label="Stop generating">
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={buttonClass}
                disabled={!draft.trim() || !effectiveProvider}
                aria-label="Send"
              >
                Send
              </button>
            )}
          </div>
        </form>
        {providers !== null && providers.length > 0 && !effectiveProvider && !streaming && (
          <p className="mt-2 text-sm text-text-muted">
            Add a provider to generate.{" "}
            <button className="underline" onClick={() => navigate("/providers")}>
              Manage providers
            </button>
          </p>
        )}
      </div>
    </footer>
  );
}
