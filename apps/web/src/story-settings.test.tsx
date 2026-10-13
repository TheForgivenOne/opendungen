// Story settings drawer tests: provider override + advanced
// overrides + per-field reset, all behind the gear icon.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render, setInputValue } from "./test-utils";
import { StoryScreen } from "./views/story";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROVIDERS = [
  {
    id: "a",
    userId: "u1",
    label: "Alpha",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "model-a",
    hasKey: false,
    isDefault: true,
    createdAt: 1,
  },
  {
    id: "b",
    userId: "u1",
    label: "Beta",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "model-b",
    hasKey: false,
    isDefault: false,
    createdAt: 2,
  },
];

let story = {
  id: "s1",
  userId: "u1",
  scenarioId: null,
  title: "Settings Story",
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

const patchBodies: unknown[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/stories/s1" && method === "GET") {
        return json({ story });
      }
      if (url === "/api/stories/s1" && method === "PATCH") {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        patchBodies.push(body);
        story = { ...story, ...body };
        return json({ story });
      }
      if (url === "/api/stories/s1/actions" && method === "GET") {
        return json({ actions: [] });
      }
      if (url === "/api/providers" && method === "GET") {
        return json({ providers: PROVIDERS });
      }
      if (url === "/api/stories/s1/ranges" && method === "GET") {
        return json({ ranges: [] });
      }
      if (url === "/api/stories/s1/scripts" && method === "GET") {
        return json({ scripts: [], readOnly: false });
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

async function settled(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function openDrawerSection(container: HTMLElement, section: string): HTMLElement {
  click(getByText(container, "⚙").closest("button") ?? getByText(container, "⚙"));
  const toggle = container.querySelector(
    `[data-drawer-section="${section}"] > button`,
  ) as HTMLButtonElement | null;
  if (!toggle) {
    throw new Error(`no ${section} section toggle`);
  }
  click(toggle);
  const panel = container.querySelector(`[data-drawer-section="${section}"]`) as HTMLElement | null;
  if (!panel) {
    throw new Error(`no ${section} section`);
  }
  return panel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  patchBodies.length = 0;
  story = { ...story, providerId: null, contextTokens: null, maxOutputTokens: null };
});

describe("story settings drawer", () => {
  it("provider dropdown PATCHes the story override", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      expect(queryByText(container, "Alpha · model-a")).not.toBeNull();
      const panel = openDrawerSection(container, "provider");
      const select = panel.querySelector(
        'select[aria-label="Story provider"]',
      ) as HTMLSelectElement;
      expect(select.value).toBe("default");
      act(() => {
        select.value = "b";
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      await settled();
      expect(patchBodies).toContainEqual({ providerId: "b" });
      expect(queryByText(container, "Beta · model-b (override)")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("advanced panel saves overrides and resets to defaults", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      const panel = openDrawerSection(container, "advanced");
      const labelText = (prefix: string) =>
        Array.from(panel.querySelectorAll("label"))
          .map((l) => l.textContent ?? "")
          .find((t) => t.startsWith(prefix));
      expect(labelText("Context tokens")).toMatch(/^Context tokens/);

      const labels = Array.from(panel.querySelectorAll("label"));
      const contextLabel = labels.find((l) => (l.textContent ?? "").startsWith("Context tokens"));
      const contextInput = contextLabel?.querySelector("input") as HTMLInputElement;
      setInputValue(contextInput, "4096");
      const advancedForm = contextLabel?.closest("form") as HTMLFormElement;
      const saveButton = Array.from(advancedForm.querySelectorAll("button")).find(
        (b) => b.textContent === "Save",
      );
      if (!saveButton) {
        throw new Error("no Advanced save button");
      }
      click(saveButton);
      await settled();
      expect(patchBodies.at(-1)).toMatchObject({ contextTokens: 4096 });

      click(getByText(panel, "Reset all to defaults"));
      await settled();
      expect(patchBodies.at(-1)).toMatchObject({
        contextTokens: null,
        maxOutputTokens: null,
        compressTriggerPct: null,
        compressMaxTokens: null,
        compressTemperature: null,
      });
    } finally {
      unmount();
    }
  });

  it("per-field reset clears one override", async () => {
    installFetch();
    story = { ...story, contextTokens: 4096 };
    const { container, unmount } = mount();
    try {
      await settled();
      const panel = openDrawerSection(container, "advanced");
      const labels = Array.from(panel.querySelectorAll("label"));
      const contextLabel = labels.find((l) => (l.textContent ?? "").startsWith("Context tokens"));
      const resetButton = Array.from(contextLabel?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "reset",
      );
      if (!resetButton) {
        throw new Error("no per-field reset button");
      }
      click(resetButton);
      await settled();
      expect(patchBodies.at(-1)).toMatchObject({ contextTokens: null });
    } finally {
      unmount();
    }
  });

  it("Esc closes the drawer", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      expect(queryByText(container, "Story settings")).toBeNull();
      click(getByText(container, "⚙").closest("button") ?? getByText(container, "⚙"));
      await settled();
      expect(queryByText(container, "Story settings")).not.toBeNull();
      act(() => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await settled();
      expect(queryByText(container, "Story settings")).toBeNull();
    } finally {
      unmount();
    }
  });
});
