// Story view tests (Phase 6): in-place editing via click →
/// contenteditable → Enter → PATCH, and header collapse on scroll.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render } from "./test-utils";
import { StoryScreen } from "./views/story";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const story = {
  id: "s1",
  userId: "u1",
  scenarioId: null,
  title: "Editable Story",
  aiInstructions: "",
  plotEssentials: "",
  memory: "",
  summary: "",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  providerId: null as string | null,
  compressTriggerPct: null as number | null,
  compressMaxTokens: null as number | null,
  compressTemperature: null as number | null,
  contextTokens: null as number | null,
  maxOutputTokens: null as number | null,
};

let actions = [
  {
    id: "a1",
    storyId: "s1",
    idx: 0,
    type: "input",
    text: "open the door",
    mode: "do",
    createdAt: 1,
  },
  {
    id: "a2",
    storyId: "s1",
    idx: 1,
    type: "output",
    text: "The door creaks.",
    mode: null,
    createdAt: 2,
  },
];

const patchBodies: { id: string; body: unknown }[] = [];
const postCalls: string[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        postCalls.push(url);
      }
      if (url === "/api/stories/s1" && method === "GET") {
        return json({ story });
      }
      if (url === "/api/stories/s1/actions" && method === "GET") {
        return json({ actions });
      }
      if (url === "/api/providers" && method === "GET") {
        return json({ providers: [] });
      }
      if (url === "/api/stories/s1/ranges" && method === "GET") {
        return json({ ranges: [] });
      }
      if (url === "/api/stories/s1/scripts" && method === "GET") {
        return json({ scripts: [], readOnly: false });
      }
      const edit = url.match(/^\/api\/stories\/s1\/actions\/([^/]+)$/);
      if (edit && method === "PATCH") {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        patchBodies.push({ id: edit[1], body });
        actions = actions.map((a) => (a.id === edit[1] ? { ...a, ...body } : a));
        return json({ action: actions.find((a) => a.id === edit[1]) });
      }
      return json({ error: { code: "not_found", message: `no mock for ${method} ${url}` } }, 404);
    }),
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <StoryScreen id="s1" />
      </ToastProvider>
    </QueryClientProvider>,
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
  patchBodies.length = 0;
  postCalls.length = 0;
  actions = [
    {
      id: "a1",
      storyId: "s1",
      idx: 0,
      type: "input",
      text: "open the door",
      mode: "do",
      createdAt: 1,
    },
    {
      id: "a2",
      storyId: "s1",
      idx: 1,
      type: "output",
      text: "The door creaks.",
      mode: null,
      createdAt: 2,
    },
  ];
});

describe("story view", () => {
  it("renders player input with a marker and output as plain prose", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      // Player do-action carries the › marker + DO tag.
      expect(queryByText(container, "›")).not.toBeNull();
      expect(queryByText(container, "DO")).not.toBeNull();
      // No card chrome: actions are plain divs, not list items.
      expect(container.querySelector("li.rounded")).toBeNull();
      expect(getByText(container, "The door creaks.")).toBeTruthy();
    } finally {
      unmount();
    }
  });

  it("shows the seeded opening with no auto-generation on arrival", async () => {
    // A fresh story from a scenario: one output action (the opening),
    // no input yet. The view renders it and fires nothing.
    actions = [
      {
        id: "a0",
        storyId: "s1",
        idx: 0,
        type: "output",
        text: "Dust hangs in the waystation air.",
        mode: null,
        createdAt: 1,
      },
    ];
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      expect(getByText(container, "Dust hangs in the waystation air.")).toBeTruthy();
      expect(postCalls).toEqual([]);
    } finally {
      unmount();
    }
  });

  it("edits an action in place: click → contenteditable → Enter → PATCH", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      // Click the output action: it becomes an editable div.
      const output = getByText(container, "The door creaks.");
      const clickable = output.closest("div[role='button']") ?? output;
      click(clickable);
      const editor = container.querySelector("div[contenteditable='true']") as HTMLElement | null;
      if (!editor) {
        throw new Error("no contenteditable editor after click");
      }
      act(() => {
        editor.textContent = "The door slams.";
        editor.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      await settled();
      expect(patchBodies).toContainEqual({ id: "a2", body: { text: "The door slams." } });
      expect(queryByText(container, "The door slams.")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("collapses the header on scroll down and expands on scroll up", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      const header = container.querySelector("header[data-collapsed]") as HTMLElement | null;
      const scroller = container.querySelector("main[aria-label='Story']") as HTMLElement | null;
      if (!header || !scroller) {
        throw new Error("missing header or scroll area");
      }
      expect(header.dataset.collapsed).toBe("false");
      act(() => {
        (scroller as HTMLElement).scrollTop = 200;
        scroller.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      expect(header.dataset.collapsed).toBe("true");
      act(() => {
        (scroller as HTMLElement).scrollTop = 0;
        scroller.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      expect(header.dataset.collapsed).toBe("false");
    } finally {
      unmount();
    }
  });
});
