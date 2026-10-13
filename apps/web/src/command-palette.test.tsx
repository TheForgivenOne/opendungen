// Command palette tests: opens, filters, selects via Enter,
// closes via Esc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider } from "./location";
import { CommandPalette } from "./command-palette";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render, setInputValue } from "./test-utils";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function story(id: string, title: string) {
  return {
    id,
    userId: "u1",
    scenarioId: null,
    title,
    aiInstructions: "",
    plotEssentials: "",
    memory: "",
    summary: "",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    providerId: null,
    compressTriggerPct: null,
    compressMaxTokens: null,
    compressTemperature: null,
    contextTokens: null,
    maxOutputTokens: null,
  };
}

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        return json({ user: { id: "u1", email: "a@b.c", instanceAdmin: false } });
      }
      if (url === "/api/stories") {
        return json({ stories: [story("s1", "Dragon Hunt"), story("s2", "Quiet Tavern")] });
      }
      return json({ error: { code: "not_found", message: "no mock" } }, 404);
    }),
  );
  window.history.replaceState(null, "", "/stories");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let closed = false;
  const ui = render(
    <LocationProvider>
      <ThemeProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <CommandPalette
              open
              onClose={() => {
                closed = true;
              }}
            />
          </QueryClientProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocationProvider>,
  );
  return { ...ui, wasClosed: () => closed };
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
  window.history.replaceState(null, "", "/");
});

describe("command palette", () => {
  it("lists actions and stories", async () => {
    const { container, unmount } = mount();
    try {
      await settled();
      expect(getByText(container, "Resume last story")).toBeTruthy();
      expect(getByText(container, "Dragon Hunt")).toBeTruthy();
      expect(getByText(container, "Quiet Tavern")).toBeTruthy();
    } finally {
      unmount();
    }
  });

  it("filters on typing and navigates on Enter", async () => {
    const { container, unmount } = mount();
    try {
      await settled();
      const input = container.querySelector('input[aria-label="Command palette"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("no palette input");
      }
      setInputValue(input, "prov");
      await settled();
      // Only the Providers action matches.
      expect(queryByText(container, "Dragon Hunt")).toBeNull();
      expect(getByText(container, "Providers")).toBeTruthy();
      act(() => {
        input.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      expect(window.location.pathname).toBe("/providers");
    } finally {
      unmount();
    }
  });

  it("selects a story by title", async () => {
    const { container, unmount } = mount();
    try {
      await settled();
      const input = container.querySelector('input[aria-label="Command palette"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("no palette input");
      }
      setInputValue(input, "tavern");
      await settled();
      act(() => {
        input.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      expect(window.location.pathname).toBe("/stories/s2");
    } finally {
      unmount();
    }
  });

  it("closes on Escape and the Close button", async () => {
    const rendered = mount();
    const { container, unmount, wasClosed } = rendered;
    try {
      await settled();
      const input = container.querySelector('input[aria-label="Command palette"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("no palette input");
      }
      act(() => {
        input.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(wasClosed()).toBe(true);
      click(getByText(container, "Close"));
      expect(wasClosed()).toBe(true);
    } finally {
      unmount();
    }
  });
});
