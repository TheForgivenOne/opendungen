// Collapsing story header: title (in-place rename), effective
// provider badge, and the hover-only context readout.

import { useState } from "react";
import { providerDisplayName, type Provider } from "../../api/providers";
import { type Story } from "../../api/stories";
import { type AppliedRange } from "../../api/generation";
import { useShellMenu } from "../../shell";
import { useSaveStory } from "../../queries";
import { formatTokens } from "../../ui";

export interface StoryHeaderProps {
  story: Story;
  effectiveProvider: Provider | null;
  overrideProvider: Provider | null;
  contextInfo: { total: number; cards: number } | null;
  appliedRanges: AppliedRange[];
  effectiveBudget: number;
  headerCollapsed: boolean;
  onOpenSettings: () => void;
}

export function StoryHeader({
  story,
  effectiveProvider,
  overrideProvider,
  contextInfo,
  appliedRanges,
  effectiveBudget,
  headerCollapsed,
  onOpenSettings,
}: StoryHeaderProps) {
  const { openDrawer: openNavDrawer } = useShellMenu();
  const saveStory = useSaveStory(story.id);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  return (
    <header
      className="group/header shrink-0 overflow-hidden transition-[max-height] duration-200"
      style={{ maxHeight: headerCollapsed ? 0 : 120 }}
      data-collapsed={headerCollapsed}
    >
      <div className="mx-auto flex w-full max-w-[680px] items-center gap-2 px-4 py-3">
        <button
          className="rounded px-2 py-1 text-text-muted hover:text-text"
          onClick={openNavDrawer}
          aria-label="Open menu"
        >
          ☰
        </button>
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              className="w-full rounded border border-border bg-surface px-2 py-1 text-[15px] font-medium"
              aria-label="Story title"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const next = titleDraft.trim();
                  if (next && next !== story.title) {
                    saveStory.mutate({ title: next });
                  }
                  setEditingTitle(false);
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              onBlur={() => setEditingTitle(false)}
            />
          ) : (
            <button
              className="block w-full truncate text-left text-[15px] font-medium hover:text-accent"
              title="Rename story"
              onClick={() => {
                setTitleDraft(story.title);
                setEditingTitle(true);
              }}
            >
              {story.title}
            </button>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
            <span>
              {effectiveProvider
                ? `${providerDisplayName(effectiveProvider)}${overrideProvider ? " (override)" : ""}`
                : "No provider"}
            </span>
            {contextInfo && (
              <span
                className="hidden font-mono group-hover/header:inline"
                title="Last turn context usage"
              >
                {formatTokens(contextInfo.total)} / {Math.round(effectiveBudget / 1000)}k
                {appliedRanges.length > 0 &&
                  ` · [${appliedRanges.map((r) => `${r.startIdx}–${r.endIdx}`).join(", ")}]`}
              </span>
            )}
          </div>
        </div>
        <button
          className="rounded px-2 py-1 text-text-muted hover:text-text"
          onClick={onOpenSettings}
          aria-label="Story settings"
          title="Story settings"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
