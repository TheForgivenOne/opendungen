import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render } from "./test-utils";
import { SettingsScreen } from "./views/settings";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INSTANCE = {
  authMode: "single",
  version: "0.1.0",
  hasSessionSecret: true,
  setupComplete: true,
  rateLimitEnabled: true,
  allowPrivateProviderUrls: false,
  logLevel: "info",
};

function account(admin: boolean) {
  return {
    user: { id: "u1", email: "admin@example.com", instanceAdmin: admin, createdAt: 1 },
    counts: { stories: 0, actions: 0, ranges: 0 },
  };
}

function installFetch(admin: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/settings/instance" && method === "GET") {
        return json(INSTANCE);
      }
      if (url === "/api/settings/account" && method === "GET") {
        return json(account(admin));
      }
      if (url === "/api/admin/cleanup" && method === "POST") {
        return json({
          deleted: { sessions: 2, rateLimits: 1, scriptStates: 0, compressedRanges: 0 },
        });
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
        <SettingsScreen />
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings instance section", () => {
  it("shows hardening posture and runs maintenance as admin", async () => {
    installFetch(true);
    const { container, unmount } = mount();
    try {
      await settled();
      expect(queryByText(container, "Rate limiting")).not.toBeNull();
      expect(queryByText(container, "enabled")?.parentElement?.textContent).toContain(
        "Rate limiting",
      );
      expect(queryByText(container, "SSRF protection")).not.toBeNull();
      expect(queryByText(container, "Log level")).not.toBeNull();
      expect(queryByText(container, "Run maintenance now")).not.toBeNull();
      click(getByText(container, "Run maintenance now"));
      await settled();
      const counts = Array.from(container.querySelectorAll("p"))
        .map((p) => p.textContent ?? "")
        .find((t) => t.startsWith("Deleted"));
      expect(counts).toContain("Deleted 2 sessions, 1 rate limits,");
    } finally {
      unmount();
    }
  });

  it("hides the maintenance button from non-admins", async () => {
    installFetch(false);
    const { container, unmount } = mount();
    try {
      await settled();
      expect(queryByText(container, "Rate limiting")).not.toBeNull();
      expect(queryByText(container, "Run maintenance now")).toBeNull();
    } finally {
      unmount();
    }
  });
});
