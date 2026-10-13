// Command palette (Phase 6): Cmd/Ctrl+K modal, no library. A
// filtered list of navigation actions + stories (+ the current
// story's scripts when in story view). Arrow keys navigate, Enter
// selects, Esc closes. ~150 lines by design.

import { useEffect, useMemo, useRef, useState } from "react";
import { logout } from "./api/auth";
import { runMaintenance } from "./api/settings";
import { type Script } from "./api/scripts";
import { navigate, useLocation } from "./location";
import { queryClient, useMe, useStories, useStoryScripts } from "./queries";
import { useTheme, type Theme } from "./theme";
import { useToast } from "./toast";
import { ghostClass, inputClass } from "./ui";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Global hotkey: Cmd/Ctrl+K toggles the palette from anywhere.
export function useCommandPaletteHotkey(onToggle: () => void): void {
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onToggle]);
}

const THEME_CYCLE: Theme[] = ["light", "dark", "system"];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const view = useLocation();
  const toast = useToast();
  const meQuery = useMe(open);
  const storiesQuery = useStories(open);
  const storyId = view.name === "story" ? view.id : null;
  const scriptsQuery = useStoryScripts(storyId ?? "", open && storyId !== null);
  const { theme, setTheme } = useTheme();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // State resets on close (never set-state-in-effect): every close
  // path below goes through close(), so opening starts clean.
  function close() {
    setFilter("");
    setIndex(0);
    onClose();
  }

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    // Focus after mount so typing filters immediately (external DOM
    // sync only — no state writes here).
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function signOut() {
    try {
      await logout();
    } catch {
      // Cookie may already be gone; still leave.
    }
    queryClient.clear();
    close();
    navigate("/login");
  }

  const items: PaletteItem[] = useMemo(() => {
    if (!open) {
      return [];
    }
    const list: PaletteItem[] = [
      { id: "resume", label: "Resume last story", run: () => navigate("/") },
      { id: "stories", label: "All stories", hint: "/stories", run: () => navigate("/stories") },
      {
        id: "new",
        label: "New story",
        hint: "scenario list",
        run: () => navigate("/scenarios/new"),
      },
      {
        id: "scenarios",
        label: "Scenarios",
        hint: "/scenarios",
        run: () => navigate("/scenarios"),
      },
      {
        id: "providers",
        label: "Providers",
        hint: "/providers",
        run: () => navigate("/providers"),
      },
      { id: "settings", label: "Settings", hint: "/settings", run: () => navigate("/settings") },
      {
        id: "theme",
        label: `Toggle theme (now ${theme})`,
        run: () => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]),
      },
      { id: "signout", label: "Sign out", run: () => void signOut() },
    ];
    if (meQuery.data?.user.instanceAdmin) {
      list.push({
        id: "maintenance",
        label: "Run maintenance",
        hint: "admin",
        run: () => {
          toast.push("success", "Running maintenance…");
          void runMaintenance().then(
            (result) => {
              const d = result.deleted;
              toast.push(
                "success",
                `Deleted ${d.sessions} sessions, ${d.rateLimits} rate limits, ${d.scriptStates} script states, ${d.compressedRanges} ranges.`,
              );
            },
            (err: unknown) =>
              toast.push("error", err instanceof Error ? err.message : "maintenance failed"),
          );
        },
      });
    }
    for (const story of storiesQuery.data?.stories ?? []) {
      list.push({
        id: `story:${story.id}`,
        label: story.title,
        hint: "story",
        run: () => navigate(`/stories/${story.id}`),
      });
    }
    const scripts: Script[] = scriptsQuery.data?.scripts ?? [];
    for (const script of scripts) {
      list.push({
        id: `script:${script.id}`,
        label: `Script: ${script.name}`,
        hint: "story script",
        run: () => {
          if (storyId) {
            navigate(`/stories/${storyId}`);
          }
          // The story view opens its settings drawer on this event.
          window.dispatchEvent(
            new CustomEvent("opendungen:open-drawer", { detail: { section: "scripts" } }),
          );
        },
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item identity refreshes per open/data change
  }, [open, theme, meQuery.data, storiesQuery.data, scriptsQuery.data, storyId]);

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter((item) => `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(needle))
    : items;
  const selected = visible[Math.min(index, Math.max(0, visible.length - 1))] ?? null;

  function choose(item: PaletteItem | null) {
    if (!item) {
      return;
    }
    close();
    item.run();
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-black/60" onClick={close} role="presentation" />
      <div className="relative w-full max-w-lg overflow-hidden rounded border border-border bg-surface">
        <input
          ref={inputRef}
          className={`${inputClass} !rounded-none !border-0 !border-b font-sans`}
          placeholder="Type a command or story title…"
          aria-label="Command palette"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(selected);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <ul className="max-h-72 overflow-y-auto p-1">
          {visible.map((item, i) => (
            <li key={item.id}>
              <button
                className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm ${
                  item.id === selected?.id ? "bg-surface-hover text-accent" : "text-text"
                }`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(item)}
              >
                <span className="truncate">{item.label}</span>
                {item.hint && (
                  <span className="shrink-0 font-mono text-xs text-text-muted">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-text-muted">No matches.</li>
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="font-mono text-xs text-text-muted">↑↓ navigate · Enter select</span>
          <button className={ghostClass} onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
