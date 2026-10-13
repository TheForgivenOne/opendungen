// Story list tabs: Playing / Completed / Drafts filtering,
// completion via the drawer action (PATCH completedAt), per-tab empty
// states.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider } from "./location";
import { Shell } from "./shell";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render } from "./test-utils";
import { StoriesScreen } from "./views/stories";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function story(id: string, completedAt: number | null = null) {
  return {
    id,
    userId: "u1",
    scenarioId: null,
    title: `Story ${id}`,
    aiInstructions: "",
    plotEssentials: "",
    memory: "",
    summary: "",
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    providerId: null,
    compressTriggerPct: null,
    compressMaxTokens: null,
    compressTemperature: null,
    contextTokens: null,
    maxOutputTokens: null,
    completedAt,
  };
}

const actionSets: Record<string, { id: string; type: string; text: string }[]> = {
  played: [
    { id: "i1", type: "input", text: "go" },
    { id: "o1", type: "output", text: "went" },
  ],
  done: [
    { id: "i2", type: "input", text: "go" },
    { id: "o2", type: "output", text: "went" },
  ],
  draft: [],
};

function mount(stories: ReturnType<typeof story>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/stories") {
        return json({ stories });
      }
      if (url === "/api/auth/me") {
        return json({ user: { id: "u1", email: "a@b.c", instanceAdmin: true } });
      }
      const match = url.match(/^\/api\/stories\/([^/]+)\/actions$/);
      if (match) {
        const actions = (actionSets[match[1]] ?? []).map((a, i) => ({
          ...a,
          storyId: match[1],
          idx: i,
          mode: a.type === "input" ? "do" : null,
          createdAt: i + 1,
        }));
        return json({ actions });
      }
      return json({ error: { code: "not_found", message: "no mock" } }, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, "", "/stories");
  return render(
    <LocationProvider>
      <ThemeProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <Shell>
              <StoriesScreen />
            </Shell>
          </QueryClientProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocationProvider>,
  );
}

async function settled(times = 10) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("story list tabs", () => {
  it("defaults to Playing with stories that have output", async () => {
    const { container, unmount } = mount([story("played"), story("done", 99), story("draft")]);
    try {
      await settled();
      const playing = getByText(container, "Playing");
      expect(playing.getAttribute("aria-selected")).toBe("true");
      expect(playing.className).toContain("border-accent");
      getByText(container, "Story played");
      expect(queryByText(container, "Story done")).toBeNull();
      expect(queryByText(container, "Story draft")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("Completed shows marked stories and Drafts shows zero-action stories", async () => {
    const { container, unmount } = mount([story("played"), story("done", 99), story("draft")]);
    try {
      await settled();
      click(getByText(container, "Completed"));
      getByText(container, "Story done");
      expect(queryByText(container, "Story played")).toBeNull();
      click(getByText(container, "Drafts"));
      getByText(container, "Story draft");
      expect(queryByText(container, "Story played")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("renders the per-tab empty states", async () => {
    const { container, unmount } = mount([]);
    try {
      await settled();
      getByText(container, "No stories in progress. Start one.");
      click(getByText(container, "Completed"));
      getByText(container, "Nothing completed yet.");
      click(getByText(container, "Drafts"));
      getByText(container, "No drafts.");
    } finally {
      unmount();
    }
  });

  it("New story navigates to the single-column flow", async () => {
    const { container, unmount } = mount([]);
    try {
      await settled();
      click(getByText(container, "New story"));
      expect(window.location.pathname).toBe("/scenarios/new");
    } finally {
      unmount();
    }
  });
});
