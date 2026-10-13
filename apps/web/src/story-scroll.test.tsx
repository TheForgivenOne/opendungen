// Phase 6c §5 (scroll bounce) + §4 (top fade): auto-scroll pins the
// bottom only while the reader is parked there, never smooth, with an
// 800ms quiet window and a scrolled-away flag; the top fade shows
// only when scrollTop > 0.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { act, click, getByText, render } from "./test-utils";
import { useStoryScroll } from "./views/story/useStoryScroll";
import { StoryScreen } from "./views/story";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settled(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- hook

function HookHarness() {
  const [streamText, setStreamText] = useState("");
  // The story resolves separately from its actions (warm actions
  // cache): the resume pin must fire when the story arrives.
  const [storyReady, setStoryReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scroll = useStoryScroll({
    scrollRef,
    inputRef,
    storyId: "s1",
    storyReady,
    actionsReady: true,
    streamText,
    visibleOverlayLength: 0,
  });
  return (
    <div
      ref={scrollRef}
      data-testid="scroller"
      onScroll={scroll.onScroll}
      style={{ height: 100, overflowY: "auto" }}
    >
      <div style={{ height: 1000 }}>tall content</div>
      <textarea ref={inputRef} data-testid="reader-input" aria-label="reader input" />
      <span data-testid="away">{scroll.userScrolledAway ? "away" : "here"}</span>
      <span data-testid="top">{scroll.scrollTop}</span>
      <button onClick={scroll.scrollToBottom}>jump to latest</button>
      <button onClick={() => setStreamText((t) => `${t}!`)}>delta</button>
      <button onClick={() => setStoryReady(true)}>story ready</button>
    </div>
  );
}

function hookScroller(container: ParentNode): HTMLElement {
  const el = container.querySelector('[data-testid="scroller"]');
  if (!(el instanceof window.HTMLElement)) {
    throw new Error("scroller missing");
  }
  return el;
}

// Fixes layout metrics jsdom cannot compute.
function mockMetrics(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  el.scrollTop = top;
}

function hookText(container: ParentNode, id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

function userScroll(container: ParentNode, top: number) {
  const el = hookScroller(container);
  mockMetrics(el, top);
  act(() => {
    el.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
}

function mountHook() {
  const rendered = render(<HookHarness />);
  const el = hookScroller(rendered.container);
  mockMetrics(el, 600);
  flushPinScroll(rendered.container);
  return { ...rendered, el };
}

// Real browsers fire a scroll event after every programmatic pin;
// jsdom does not, so dispatch one to consume the pin guard exactly
// as the browser's async event would.
function flushPinScroll(container: ParentNode) {
  const el = hookScroller(container);
  act(() => {
    el.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
}

function sendDelta(container: ParentNode) {
  click(getByText(container, "delta"));
}

describe("useStoryScroll resume", () => {
  it("pins to the bottom with input focused when the story arrives after warm actions", () => {
    const { container, unmount, el } = mountHook();
    try {
      el.scrollTop = 0;
      expect(el.scrollTop).toBe(0);
      // Actions were already cached; the story resolving triggers
      // the one-shot resume pin (the Home-card navigation path).
      click(getByText(container, "story ready"));
      expect(el.scrollTop).toBe(1000);
      expect(document.activeElement?.getAttribute("data-testid")).toBe("reader-input");
      (document.activeElement as HTMLElement | null)?.blur?.();
    } finally {
      unmount();
    }
  });
});

describe("useStoryScroll streaming contract", () => {
  it("auto-scrolls on each delta while the reader is at the bottom", () => {
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const { container, unmount, el } = mountHook();
    try {
      // Parked at the bottom (1000 - 600 - 400 = 0 < 200).
      userScroll(container, 600);
      expect(hookText(container, "away")).toBe("here");
      t += 1000;
      el.scrollTop = 0;
      // A new delta pins the bottom instantly (no animation).
      sendDelta(container);
      expect(el.scrollTop).toBe(1000);
    } finally {
      unmount();
    }
  });

  it("stops auto-scrolling after the user scrolls up mid-stream", () => {
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const { container, unmount, el } = mountHook();
    try {
      userScroll(container, 600);
      userScroll(container, 100);
      expect(hookText(container, "away")).toBe("away");
      el.scrollTop = 100;
      t += 1000;
      sendDelta(container);
      expect(el.scrollTop).toBe(100);
      // Further deltas also stay put.
      sendDelta(container);
      expect(el.scrollTop).toBe(100);
    } finally {
      unmount();
    }
  });

  it("jump to latest clears the flag and resumes auto-scroll", () => {
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const { container, unmount, el } = mountHook();
    try {
      userScroll(container, 600);
      userScroll(container, 100);
      expect(hookText(container, "away")).toBe("away");
      click(getByText(container, "jump to latest"));
      flushPinScroll(container);
      expect(el.scrollTop).toBe(1000);
      expect(hookText(container, "away")).toBe("here");
      el.scrollTop = 0;
      t += 1000;
      sendDelta(container);
      expect(el.scrollTop).toBe(1000);
    } finally {
      unmount();
    }
  });

  it("scrolling back to the bottom clears the flag", () => {
    const { container, unmount } = mountHook();
    try {
      userScroll(container, 600);
      userScroll(container, 100);
      expect(hookText(container, "away")).toBe("away");
      userScroll(container, 600);
      expect(hookText(container, "away")).toBe("here");
    } finally {
      unmount();
    }
  });

  it("does not auto-scroll within 800ms of a scroll, even at the bottom", () => {
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const { container, unmount, el } = mountHook();
    try {
      userScroll(container, 600);
      t += 100;
      el.scrollTop = 0;
      sendDelta(container);
      // The reader scrolled 100ms ago: stay put despite being pinned.
      expect(el.scrollTop).toBe(0);
      t += 1000;
      sendDelta(container);
      expect(el.scrollTop).toBe(1000);
    } finally {
      unmount();
    }
  });
});

// ---------------------------------------------------------------- fade

const story = {
  id: "s1",
  userId: "u1",
  scenarioId: null,
  title: "Fade Story",
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

const actions = [
  { id: "a1", storyId: "s1", idx: 0, type: "input", text: "open", mode: "do", createdAt: 1 },
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

function installStoryFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/stories/s1") {
        return json({ story });
      }
      if (url === "/api/stories/s1/actions") {
        return json({ actions });
      }
      if (url === "/api/providers") {
        return json({ providers: [] });
      }
      if (url === "/api/stories/s1/ranges") {
        return json({ ranges: [] });
      }
      if (url === "/api/stories/s1/scripts") {
        return json({ scripts: [], readOnly: false });
      }
      return json({ error: { code: "not_found", message: "no mock" } }, 404);
    }),
  );
}

function storyFade(container: ParentNode): HTMLElement {
  const main = container.querySelector("main[aria-label='Story']");
  if (!(main instanceof window.HTMLElement)) {
    throw new Error("story scroll area missing");
  }
  const fade = main.querySelector("div.sticky");
  if (!(fade instanceof window.HTMLElement)) {
    throw new Error("top fade missing");
  }
  return fade;
}

describe("story top fade", () => {
  it("is hidden at scrollTop 0, appears on scroll, hides on return", async () => {
    installStoryFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, unmount } = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <StoryScreen id="s1" />
        </ToastProvider>
      </QueryClientProvider>,
    );
    try {
      await settled(10);
      const main = container.querySelector("main[aria-label='Story']");
      if (!(main instanceof window.HTMLElement)) {
        throw new Error("story scroll area missing");
      }
      Object.defineProperty(main, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(main, "clientHeight", { configurable: true, get: () => 400 });

      const fade = storyFade(container);
      // Narrow gradient (24px), transparent at scrollTop 0.
      expect(fade.className).toContain("h-6");
      expect(fade.style.opacity).toBe("0");

      act(() => {
        main.scrollTop = 200;
        main.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      expect(storyFade(container).style.opacity).toBe("1");

      act(() => {
        main.scrollTop = 0;
        main.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      expect(storyFade(container).style.opacity).toBe("0");
    } finally {
      unmount();
    }
  });
});
