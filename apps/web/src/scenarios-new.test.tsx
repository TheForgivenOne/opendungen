// New-story two-screen flow: /scenarios/new is a
// single-column list (first item pre-selected, Enter/click advances);
// /scenarios/new/name is one centered field, pre-filled, Enter creates.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider, useLocation } from "./location";
import { ToastProvider } from "./toast";
import { click, getByText, render, setInputValue } from "./test-utils";
import { NewScenarioNameScreen, NewScenarioScreen } from "./views/scenarios/NewStoryFlow";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SCENARIOS = [
  {
    id: "builtin-fantasy-waystation",
    title: "Embers of the Waystation",
    description: "A ruined waystation.",
    tags: ["fantasy"],
    builtin: true,
  },
  {
    id: "builtin-scifi-derelict",
    title: "The Kestrel Silence",
    description: "A silent ship.",
    tags: ["sci-fi"],
    builtin: true,
  },
];

const storyPosts: { title: string; scenarioId: string | null }[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/scenarios" && method === "GET") {
        return json({ scenarios: SCENARIOS });
      }
      if (url === "/api/stories" && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        storyPosts.push({
          title: body.title as string,
          scenarioId: (body.scenarioId as string | undefined) ?? null,
        });
        return json(
          {
            story: {
              id: "sn1",
              userId: "u1",
              scenarioId: body.scenarioId ?? null,
              title: body.title,
              aiInstructions: "",
              plotEssentials: "",
              memory: "",
              summary: "",
              createdAt: 1,
              updatedAt: 1,
              deletedAt: null,
              completedAt: null,
            },
          },
          201,
        );
      }
      return json({ error: { code: "not_found", message: `no mock for ${method} ${url}` } }, 404);
    }),
  );
}

function Router() {
  const view = useLocation();
  if (view.name === "scenario-new") {
    return <NewScenarioScreen />;
  }
  if (view.name === "scenario-new-name") {
    return <NewScenarioNameScreen />;
  }
  return <p data-testid="elsewhere">{window.location.pathname}</p>;
}

function mountAt(path: string) {
  installFetch();
  window.history.replaceState(null, "", path);
  window.sessionStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocationProvider>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <Router />
        </QueryClientProvider>
      </ToastProvider>
    </LocationProvider>,
  );
}

async function settled(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  storyPosts.length = 0;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("new story flow", () => {
  it("renders the single-column list with the first item pre-selected", async () => {
    const { container, unmount } = mountAt("/scenarios/new");
    try {
      await settled();
      getByText(container, "New story");
      const options = Array.from(container.querySelectorAll("[role='option']"));
      expect(options).toHaveLength(2);
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      expect(options[0].className).toContain("h-14");
      expect(options[0].className).toContain("border-accent");
    } finally {
      unmount();
    }
  });

  it("Enter on the selected row advances to the name screen", async () => {
    const { container, unmount } = mountAt("/scenarios/new");
    try {
      await settled();
      const options = Array.from(container.querySelectorAll("[role='option']"));
      const first = options[0];
      if (!first) {
        throw new Error("no options");
      }
      act(() => {
        first.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      expect(window.location.pathname).toBe("/scenarios/new/name");
    } finally {
      unmount();
    }
  });

  it("click selects and advances", async () => {
    const { container, unmount } = mountAt("/scenarios/new");
    try {
      await settled();
      click(getByText(container, "The Kestrel Silence"));
      expect(window.location.pathname).toBe("/scenarios/new/name");
      expect(window.sessionStorage.getItem("opendungen.newStory.scenarioId")).toBe(
        "builtin-scifi-derelict",
      );
    } finally {
      unmount();
    }
  });

  it("name pre-fills from the scenario and Enter creates the story", async () => {
    const { container, unmount } = mountAt("/scenarios/new");
    try {
      await settled();
      click(getByText(container, "The Kestrel Silence"));
      await settled();
      const name = container.querySelector("input[placeholder='Name your character.']");
      if (!(name instanceof window.HTMLInputElement)) {
        throw new Error("name input missing");
      }
      // Pre-filled from the scenario title.
      expect(name.value).toBe("The Kestrel Silence");
      expect(name.className).toContain("font-serif");
      expect(name.className).toContain("text-center");
      setInputValue(name, "Rook");
      act(() => {
        name.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      // Enter in a text input submits the form → creates the story.
      await settled();
      expect(storyPosts).toEqual([{ title: "Rook", scenarioId: "builtin-scifi-derelict" }]);
      expect(window.location.pathname).toBe("/stories/sn1");
    } finally {
      unmount();
    }
  });
});
