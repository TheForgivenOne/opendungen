// Stories list: plain rows under three tabs — Playing
// (an output exists), Completed (marked complete in the story drawer),
// Drafts (zero actions). Search + text sort menu sit above the tabs;
// counts come from the same per-story action queries as the rows.

import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { listActions } from "../api/stories";
import { navigate } from "../location";
import { useShellMenu } from "../shell";
import { useStories, useStoryActions } from "../queries";
import { Skeleton, buttonClass, formatRelative } from "../ui";

type Sort = "updated" | "created" | "title";
type Tab = "playing" | "completed" | "drafts";

const SORTS: { value: Sort; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "title", label: "Title" },
];

const TABS: { value: Tab; label: string }[] = [
  { value: "playing", label: "Playing" },
  { value: "completed", label: "Completed" },
  { value: "drafts", label: "Drafts" },
];

const TAB_EMPTY: Record<Tab, string> = {
  playing: "No stories in progress. Start one.",
  completed: "Nothing completed yet.",
  drafts: "No drafts.",
};

const PAGE_SIZE = 20;

function StoryRow({
  id,
  title,
  updatedAt,
  emphasized,
}: {
  id: string;
  title: string;
  updatedAt: number;
  emphasized: boolean;
}) {
  const actionsQuery = useStoryActions(id);
  const count = actionsQuery.data ? actionsQuery.data.actions.length : null;
  return (
    <li>
      <a
        href={`/stories/${id}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(`/stories/${id}`);
        }}
        className="group/row block rounded px-2 py-2 hover:bg-surface-hover"
      >
        <span className={`block truncate text-[15px] ${emphasized ? "font-medium text-text" : ""}`}>
          {title}
        </span>
        <span className="mt-0.5 flex items-center gap-2 font-mono text-xs text-text-muted">
          <span>
            {formatRelative(updatedAt)}
            {emphasized ? " · Continue" : ""}
          </span>
          {count !== null && (
            <span className="hidden group-hover/row:inline">
              {count} action{count === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

export function StoriesScreen() {
  const { openDrawer } = useShellMenu();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [tab, setTab] = useState<Tab>("playing");
  const [expanded, setExpanded] = useState(false);
  const storiesQuery = useStories();
  const stories = storiesQuery.data?.stories ?? [];

  // Per-story action counts (same keys as the rows, so no extra fetches).
  const actionQueries = useQueries({
    queries: stories.map((story) => ({
      queryKey: ["actions", story.id],
      queryFn: () => listActions(story.id),
    })),
  });
  const counts = new Map(stories.map((story, i) => [story.id, actionQueries[i]?.data ?? null]));

  const needle = search.trim().toLowerCase();
  const searched = stories.filter((s) => !needle || s.title.toLowerCase().includes(needle));
  const inTab = searched.filter((story) => {
    if (story.completedAt !== null && story.completedAt !== undefined) {
      return tab === "completed";
    }
    if (tab === "completed") {
      return false;
    }
    const entry = counts.get(story.id);
    const loaded = entry !== null && entry !== undefined;
    if (tab === "drafts") {
      return loaded && entry.actions.length === 0;
    }
    // Playing: at least one output action; unloaded rows stay here so
    // the default tab never flickers empty while counts resolve.
    return !loaded || entry.actions.some((a) => a.type === "output");
  });
  const sorted = [...inTab].sort((a, b) => {
    if (sort === "title") {
      return a.title.localeCompare(b.title);
    }
    if (sort === "created") {
      return b.createdAt - a.createdAt;
    }
    return b.updatedAt - a.updatedAt;
  });
  // The most recently updated story is emphasized (bright title +
  // Continue hint); under the default sort it is already the top row.
  const newestId =
    stories.length > 0
      ? ([...stories].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null)
      : null;
  const visible = expanded ? sorted : sorted.slice(0, PAGE_SIZE);

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <div className="mb-4 flex items-center gap-2">
        <button
          className="rounded px-2 py-1 text-text-muted hover:text-text sm:hidden"
          onClick={openDrawer}
          aria-label="Open menu"
        >
          ☰
        </button>
        <h1 className="flex-1 text-xl font-bold">Stories</h1>
        <button className={buttonClass} onClick={() => navigate("/scenarios/new")}>
          New story
        </button>
      </div>
      <div className="mb-2">
        <input
          className="w-full border-b border-border bg-transparent py-2 text-[15px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          placeholder="Search"
          aria-label="Search stories"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="mb-3 flex items-center gap-1 font-mono text-xs" aria-label="Sort stories">
        {SORTS.map((item, i) => (
          <span key={item.value} className="flex items-center gap-1">
            {i > 0 && (
              <span className="text-text-muted" aria-hidden="true">
                ·
              </span>
            )}
            <button
              className={sort === item.value ? "text-accent" : "text-text-muted hover:text-text"}
              aria-pressed={sort === item.value}
              onClick={() => setSort(item.value)}
            >
              {item.label}
            </button>
          </span>
        ))}
      </div>
      <div
        className="mb-3 flex items-center justify-center gap-5"
        role="tablist"
        aria-label="Story lists"
      >
        {TABS.map((item) => (
          <button
            key={item.value}
            role="tab"
            aria-selected={tab === item.value}
            onClick={() => setTab(item.value)}
            className={`border-b-2 pb-1 text-sm ${
              tab === item.value
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {storiesQuery.isPending ? (
        <Skeleton lines={4} />
      ) : storiesQuery.isError ? (
        <p className="text-sm text-danger">Could not load stories.</p>
      ) : sorted.length === 0 ? (
        <div className="py-16 text-center">
          <p className="mb-4 text-text-muted">
            {needle ? "No stories match your search." : TAB_EMPTY[tab]}
          </p>
          {!needle && tab === "playing" && (
            <button className={buttonClass} onClick={() => navigate("/scenarios/new")}>
              Start one
            </button>
          )}
        </div>
      ) : (
        <>
          <ul className="flex flex-col">
            {visible.map((story) => (
              <StoryRow
                key={story.id}
                id={story.id}
                title={story.title}
                updatedAt={story.updatedAt}
                emphasized={story.id === newestId}
              />
            ))}
          </ul>
          {!expanded && sorted.length > PAGE_SIZE && (
            <button
              className="mt-3 font-mono text-xs text-text-muted hover:text-text"
              onClick={() => setExpanded(true)}
            >
              View all stories ({sorted.length})
            </button>
          )}
        </>
      )}
    </div>
  );
}
