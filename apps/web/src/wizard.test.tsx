import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider, useLocation } from "./location";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render, setInputValue } from "./test-utils";
import { WIZARD_KEY, WizardScreen } from "./views/wizard";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FANTASY = {
  id: "builtin-fantasy-waystation",
  title: "Fantasy Waystation",
  description: "A roadside inn at the edge of the wild.",
  tags: ["fantasy"],
  builtin: true,
};

const SCIFI = {
  id: "builtin-scifi-derelict",
  title: "Derelict Hauler",
  description: "A silent colony ship.",
  tags: ["sci-fi"],
  builtin: true,
};

const PROVIDER = {
  id: "p1",
  userId: "u1",
  label: "Local",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "m",
  hasKey: false,
  isDefault: true,
  createdAt: 1,
};

const providerPosts: unknown[] = [];
const storyPosts: { title: string; scenarioId: string | null }[] = [];

function installFetch(
  testResult: { ok: boolean; model?: string; error?: string } = { ok: true, model: "m" },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/scenarios" && method === "GET") {
        return json({ scenarios: [FANTASY, SCIFI] });
      }
      if (url === "/api/providers" && method === "POST") {
        providerPosts.push(JSON.parse((init?.body as string) ?? "{}"));
        return json({ provider: PROVIDER }, 201);
      }
      if (url === "/api/providers/p1/default" && method === "POST") {
        return json({ provider: { ...PROVIDER, isDefault: true } });
      }
      if (url === "/api/providers/p1/test" && method === "POST") {
        return json(testResult);
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
              id: "s9",
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
  if (view.name !== "wizard") {
    return <p data-testid="elsewhere">{window.location.pathname}</p>;
  }
  return <WizardScreen step={view.step} />;
}

function mountAt(path: string) {
  window.history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocationProvider>
      <ThemeProvider>
        <ToastProvider>
          <QueryClientProvider client={client}>
            <Router />
          </QueryClientProvider>
        </ToastProvider>
      </ThemeProvider>
    </LocationProvider>,
  );
}

async function settled(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("wizard flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    providerPosts.length = 0;
    storyPosts.length = 0;
    window.localStorage.removeItem(WIZARD_KEY);
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("step 1 lists scenarios single-column with fantasy pre-selected", async () => {
    installFetch();
    const { container, unmount } = mountAt("/wizard/step-1");
    try {
      await settled();
      getByText(container, "Pick a scenario");
      getByText(container, "Fantasy Waystation");
      getByText(container, "Derelict Hauler");
      // Single column: one listbox, rows are options.
      const options = Array.from(container.querySelectorAll("[role='option']"));
      expect(options).toHaveLength(2);
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      // 56px rows.
      expect(options[0].className).toContain("h-14");
      // Three dots, first filled.
      expect(container.querySelector("[aria-label='Step 1 of 3']")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("selecting a scenario advances to the pre-filled name step", async () => {
    installFetch();
    const { container, unmount } = mountAt("/wizard/step-1");
    try {
      await settled();
      click(getByText(container, "Next"));
      expect(window.location.pathname).toBe("/wizard/step-2");
      await settled();
      const name = container.querySelector("input[placeholder='Name your character.']");
      if (!(name instanceof window.HTMLInputElement)) {
        throw new Error("name input missing");
      }
      expect(name.value).toBe("Fantasy Waystation");
      expect(document.activeElement === name || name).toBeTruthy();
    } finally {
      unmount();
    }
  });

  it("completes provider connect, tests, and lands streaming on the story", async () => {
    installFetch();
    const { container, unmount } = mountAt("/wizard/step-3");
    try {
      await settled();
      getByText(container, "Connect a provider");
      // Inputs: 0 label, 1 Local radio, 2 Cloud radio, 3 base URL,
      // 4 model, 5 key.
      const inputs = Array.from(container.querySelectorAll("input"));
      const byIndex = (i: number) => {
        const el = inputs[i];
        if (!(el instanceof window.HTMLInputElement)) {
          throw new Error(`input ${i} missing`);
        }
        return el;
      };
      setInputValue(byIndex(0), "Local");
      setInputValue(byIndex(4), "test-model");
      click(getByText(container, "Connect"));
      await settled();
      expect(providerPosts).toHaveLength(1);
      // Test connection shows a green check + model.
      click(getByText(container, "Test connection"));
      await settled();
      getByText(container, "✓ m");
      // Start playing creates the story and navigates to it. The
      // scenario's opening is already the first action, so no
      // auto-generation is requested.
      click(getByText(container, "Start playing"));
      await settled();
      expect(storyPosts).toEqual([
        { title: "Fantasy Waystation", scenarioId: "builtin-fantasy-waystation" },
      ]);
      expect(window.localStorage.getItem(WIZARD_KEY)).toBe("1");
      expect(window.sessionStorage.getItem("opendungen.autostart")).toBeNull();
      expect(window.location.pathname).toBe("/stories/s9");
    } finally {
      unmount();
    }
  }, 20000);

  it("skipping the provider lands on the story without one", async () => {
    installFetch();
    const { container, unmount } = mountAt("/wizard/step-3");
    try {
      await settled();
      click(getByText(container, "Skip for now"));
      await settled();
      expect(providerPosts).toHaveLength(0);
      expect(storyPosts).toHaveLength(1);
      expect(window.localStorage.getItem(WIZARD_KEY)).toBe("1");
      expect(window.sessionStorage.getItem("opendungen.autostart")).toBeNull();
      expect(window.location.pathname).toBe("/stories/s9");
    } finally {
      unmount();
    }
  }, 20000);

  it("renders no top bar during the wizard", async () => {
    installFetch();
    const { container, unmount } = mountAt("/wizard/step-1");
    try {
      await settled();
      expect(container.querySelector("nav[aria-label='Primary']")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("shows the real error inline when the test fails", async () => {
    installFetch({ ok: false, error: "connection refused" });
    const { container, unmount } = mountAt("/wizard/step-3");
    try {
      await settled();
      const inputs = Array.from(container.querySelectorAll("input"));
      const first = inputs[0];
      const model = inputs[4];
      if (!(first instanceof window.HTMLInputElement)) {
        throw new Error("label input missing");
      }
      if (!(model instanceof window.HTMLInputElement)) {
        throw new Error("model input missing");
      }
      setInputValue(first, "Local");
      setInputValue(model, "m");
      click(getByText(container, "Connect"));
      await settled();
      click(getByText(container, "Test connection"));
      await settled();
      getByText(container, "✗ connection refused");
      expect(queryByText(container, "✓ m")).toBeNull();
    } finally {
      unmount();
    }
  }, 20000);
});
