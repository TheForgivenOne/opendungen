import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider, useLocation } from "./location";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render, setInputValue } from "./test-utils";
import { ScenariosScreen } from "./views/scenarios/ScenariosScreen";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BUILTIN = {
  id: "builtin-fantasy-waystation",
  title: "Embers",
  description: "A roadside inn.",
  tags: ["fantasy"],
  builtin: true,
};

const OWNED = {
  id: "user-1",
  title: "Mine",
  description: "My scenario.",
  tags: [],
  builtin: false,
};

const bodies: { method: string; url: string; body: unknown }[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
      bodies.push({ method, url, body });
      if (url === "/api/scenarios" && method === "GET") {
        return json({ scenarios: [BUILTIN, OWNED] });
      }
      if (url === "/api/scenarios" && method === "POST") {
        const form = body as Record<string, unknown>;
        return json(
          {
            scenario: {
              id: "user-2",
              builtin: false,
              description: "",
              opening: "",
              aiInstructions: "",
              tags: [],
              ...form,
            },
          },
          201,
        );
      }
      if (url === "/api/scenarios/builtin-fantasy-waystation/duplicate" && method === "POST") {
        return json({ scenario: { ...BUILTIN, id: "user-3", builtin: false } }, 201);
      }
      return json({ error: { code: "not_found", message: `no mock for ${method} ${url}` } }, 404);
    }),
  );
}

function Router() {
  const view = useLocation();
  if (view.name !== "scenarios") {
    return <p data-testid="elsewhere">{window.location.pathname}</p>;
  }
  return <ScenariosScreen />;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.pushState({}, "", "/scenarios");
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
  bodies.length = 0;
});

describe("scenarios screen authoring", () => {
  it("shows Duplicate for builtins and Edit/Delete for owned", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      expect(queryByText(container, "Duplicate")).not.toBeNull();
      expect(queryByText(container, "Edit")).not.toBeNull();
      expect(queryByText(container, "Delete")).not.toBeNull();
      expect(queryByText(container, "New scenario")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("creates a scenario through the modal", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      click(getByText(container, "New scenario"));
      const titleInput = container.querySelector('input[value=""]') as HTMLInputElement | null;
      if (!titleInput) {
        throw new Error("no title input");
      }
      setInputValue(titleInput, "Fresh Tale");
      const modal = titleInput.closest("div");
      const save = Array.from(modal?.querySelectorAll("button") ?? []).find(
        (b) => b.textContent === "Save",
      );
      if (!save) {
        throw new Error("no modal save");
      }
      click(save);
      await settled();
      const posted = bodies.find((b) => b.method === "POST" && b.url === "/api/scenarios");
      expect(posted?.body).toMatchObject({ title: "Fresh Tale", tags: [] });
    } finally {
      unmount();
    }
  });

  it("duplicates a builtin and navigates to the copy", async () => {
    installFetch();
    const { container, unmount } = mount();
    try {
      await settled();
      click(getByText(container, "Duplicate"));
      await settled();
      expect(window.location.pathname).toBe("/scenarios/user-3");
    } finally {
      unmount();
    }
  });
});
