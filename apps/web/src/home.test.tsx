// Landing route: / renders a Home Continue card for the
// newest story (never auto-navigates); zero stories keeps the
// one-scenario empty state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { click, getByText, render } from "./test-utils";
import { HomeScreen } from "./views/home";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function story(id: string, updatedAt: number, scenarioId: string | null = null) {
  return {
    id,
    userId: "u1",
    scenarioId,
    title: `Story ${id}`,
    aiInstructions: "",
    plotEssentials: "",
    memory: "",
    summary: "",
    createdAt: 1,
    updatedAt,
    deletedAt: null,
    providerId: null,
    compressTriggerPct: null,
    compressMaxTokens: null,
    compressTemperature: null,
    contextTokens: null,
    maxOutputTokens: null,
    completedAt: null,
  };
}

function action(id: string, storyId: string, idx: number, type: "input" | "output", text: string) {
  return { id, storyId, idx, type, text, mode: type === "input" ? "do" : null, createdAt: idx };
}

const FANTASY = {
  id: "builtin-fantasy-waystation",
  title: "Embers of the Waystation",
  description: "A ruined waystation squats at the crossroads.",
  tags: ["fantasy"],
  builtin: true,
};

const FANTASY_DETAIL = {
  ...FANTASY,
  opening: "You wake alone in a broken tower.",
  aiInstructions: "",
};

const createdStories: { title: string; scenarioId: string | null }[] = [];

function mount(
  stories: ReturnType<typeof story>[],
  actionsByStory: Record<string, ReturnType<typeof action>[]> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/stories" && method === "GET") {
        return json({ stories });
      }
      if (url === "/api/scenarios" && method === "GET") {
        return json({ scenarios: [FANTASY] });
      }
      const actionsMatch = /^\/api\/stories\/([^/]+)\/actions$/.exec(url);
      if (actionsMatch && method === "GET") {
        return json({ actions: actionsByStory[actionsMatch[1] ?? ""] ?? [] });
      }
      if (url === "/api/scenarios/builtin-fantasy-waystation" && method === "GET") {
        return json({ scenario: FANTASY_DETAIL });
      }
      if (url === "/api/stories" && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          title: string;
          scenarioId?: string;
        };
        createdStories.push({ title: body.title, scenarioId: body.scenarioId ?? null });
        return json(
          {
            story: {
              ...story("fresh", 5),
              id: "fresh",
              title: body.title,
              scenarioId: body.scenarioId ?? null,
            },
          },
          201,
        );
      }
      return json({ error: { code: "not_found", message: "no mock" } }, 404);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, "", "/");
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <HomeScreen />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function byTestId(container: ParentNode, id: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!(el instanceof window.HTMLElement)) {
    throw new Error(`missing [data-testid="${id}"]`);
  }
  return el;
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
  createdStories.length = 0;
  window.history.replaceState(null, "", "/");
});

describe("home continue card", () => {
  it("renders the Continue card for the newest story without navigating", async () => {
    const { container, unmount } = mount(
      [story("old", 100, "builtin-fantasy-waystation"), story("new", 300)],
      {
        new: [
          action("a1", "new", 0, "input", "You push the door."),
          action("a2", "new", 1, "output", "The door creaks open on rusted hinges."),
        ],
      },
    );
    try {
      await settled();
      // No auto-navigate: the user stays on / and chooses.
      expect(window.location.pathname).toBe("/");
      expect(container.querySelector('[data-testid="continue-card"]')).not.toBeNull();
      expect(byTestId(container, "continue-title").textContent).toBe("Story new");
      expect(byTestId(container, "continue-meta").textContent).toContain("Last played");
      expect(byTestId(container, "continue-meta").textContent).toContain("2 actions");
      // Preview is the last output's text.
      expect(byTestId(container, "continue-preview").textContent).toContain(
        "The door creaks open on rusted hinges.",
      );
      expect(byTestId(container, "continue-button").textContent).toBe("Continue");
      getByText(container, "All stories →");
    } finally {
      unmount();
    }
  });

  it("clicking Continue navigates to the story", async () => {
    const { container, unmount } = mount([story("new", 300)], {
      new: [action("a2", "new", 1, "output", "The door creaks.")],
    });
    try {
      await settled();
      click(byTestId(container, "continue-button"));
      expect(window.location.pathname).toBe("/stories/new");
    } finally {
      unmount();
    }
  });

  it("shows the scenario context line for scenario stories", async () => {
    const { container, unmount } = mount([story("old", 300, "builtin-fantasy-waystation")], {
      old: [action("a1", "old", 0, "output", "Dust settles.")],
    });
    try {
      await settled();
      expect(byTestId(container, "continue-context").textContent).toBe(
        "Embers of the Waystation · fantasy",
      );
    } finally {
      unmount();
    }
  });

  it("renders the empty state when there are no stories", async () => {
    const { container, unmount } = mount([]);
    try {
      await settled();
      expect(window.location.pathname).toBe("/");
      getByText(container, "Embers of the Waystation");
      getByText(container, "Begin");
      expect(container.querySelector('[data-testid="continue-card"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it("shows Start writing for a draft with zero actions", async () => {
    const { container, unmount } = mount([story("draft", 300)], { draft: [] });
    try {
      await settled();
      expect(byTestId(container, "continue-button").textContent).toBe("Start writing");
    } finally {
      unmount();
    }
  });

  it("shows the input text as preview when the last action is an input", async () => {
    const { container, unmount } = mount([story("err", 300)], {
      err: [action("a1", "err", 0, "input", "You shout into the dark.")],
    });
    try {
      await settled();
      expect(byTestId(container, "continue-preview").textContent).toContain(
        "You shout into the dark.",
      );
    } finally {
      unmount();
    }
  });

  it("falls back to the scenario opening when there is no output", async () => {
    const { container, unmount } = mount([story("fresh", 300, "builtin-fantasy-waystation")], {
      fresh: [],
    });
    try {
      await settled();
      expect(byTestId(container, "continue-preview").textContent).toContain(
        "You wake alone in a broken tower.",
      );
    } finally {
      unmount();
    }
  });
});
