// Shell tests: nav drawer open/close, active highlighting, URL-synced
// navigation. The shell itself renders no chrome — a harness child
// provides the hamburger via useShellMenu, like real view headers.

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocationProvider, navigate } from "./location";
import { Shell, useShellMenu } from "./shell";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./toast";
import { click, getByText, queryByText, render } from "./test-utils";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function MenuButton() {
  const { openDrawer } = useShellMenu();
  return <button onClick={openDrawer}>☰</button>;
}

describe("shell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  function renderShell(path: string) {
    window.history.replaceState(null, "", path);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me") {
          return json({ user: { id: "u1", email: "a@b.c", instanceAdmin: true } });
        }
        return json({ error: { code: "not_found", message: "no mock" } }, 404);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <LocationProvider>
        <ThemeProvider>
          <ToastProvider>
            <QueryClientProvider client={client}>
              <Shell>
                <MenuButton />
                <p>content</p>
              </Shell>
            </QueryClientProvider>
          </ToastProvider>
        </ThemeProvider>
      </LocationProvider>,
    );
  }

  it("renders children with no persistent sidebar", () => {
    const { container, unmount } = renderShell("/stories");
    try {
      expect(getByText(container, "content")).toBeTruthy();
      // Nav items live behind the drawer, not in the open page.
      expect(queryByText(container, "Providers")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("highlights the active nav item", () => {
    const { container, unmount } = renderShell("/providers");
    try {
      click(getByText(container, "☰"));
      const providers = getByText(container, "Providers");
      expect(providers.closest("button")?.getAttribute("aria-current")).toBe("page");
      const stories = getByText(container, "Stories");
      expect(stories.closest("button")?.getAttribute("aria-current")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("marks Stories active for a story route", () => {
    const { container, unmount } = renderShell("/stories/abc");
    try {
      click(getByText(container, "☰"));
      expect(getByText(container, "Stories").closest("button")?.getAttribute("aria-current")).toBe(
        "page",
      );
    } finally {
      unmount();
    }
  });

  it("navigates on nav click and closes the drawer", () => {
    const { container, unmount } = renderShell("/stories");
    try {
      click(getByText(container, "☰"));
      const settings = getByText(container, "Settings");
      click(settings.closest("button") ?? settings);
      expect(window.location.pathname).toBe("/settings");
      expect(queryByText(container, "✕")).toBeNull();
      expect(navigate).toBeDefined();
    } finally {
      unmount();
    }
  });

  it("opens and closes the drawer", () => {
    const { container, unmount } = renderShell("/stories");
    try {
      // The drawer's close button (✕) exists only while it is open.
      expect(queryByText(container, "✕")).toBeNull();
      click(getByText(container, "☰"));
      expect(getByText(container, "✕")).toBeTruthy();
      click(getByText(container, "✕"));
      expect(queryByText(container, "✕")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("renders the persistent top bar on app routes", () => {
    const { container, unmount } = renderShell("/stories");
    try {
      const bar = container.querySelector("nav[aria-label='Primary']");
      if (!bar) {
        throw new Error("top bar missing");
      }
      // 40px tall with a bottom border.
      expect(bar.className).toContain("h-10");
      expect(bar.className).toContain("border-b");
      getByText(bar as unknown as ParentNode, "Stories");
      getByText(bar as unknown as ParentNode, "Scenarios");
      const home = bar.querySelector("button[aria-label='Home']");
      const gear = bar.querySelector("button[aria-label='Settings']");
      if (!home || !gear) {
        throw new Error("top bar home/settings missing");
      }
    } finally {
      unmount();
    }
  });

  it("navigates from the top bar", () => {
    const { container, unmount } = renderShell("/stories");
    try {
      const bar = container.querySelector("nav[aria-label='Primary']");
      if (!bar) {
        throw new Error("top bar missing");
      }
      click(getByText(bar as unknown as ParentNode, "Scenarios"));
      expect(window.location.pathname).toBe("/scenarios");
      click(getByText(bar as unknown as ParentNode, "Stories"));
      expect(window.location.pathname).toBe("/stories");
    } finally {
      unmount();
    }
  });

  it("highlights the active top bar item by route", () => {
    const { container, unmount } = renderShell("/stories/abc");
    try {
      const bar = container.querySelector("nav[aria-label='Primary']");
      if (!bar) {
        throw new Error("top bar missing");
      }
      const scope = bar as unknown as ParentNode;
      // Stories stays active on a story route; Scenarios does not.
      expect(getByText(scope, "Stories").getAttribute("aria-current")).toBe("page");
      expect(getByText(scope, "Scenarios").getAttribute("aria-current")).toBeNull();
    } finally {
      unmount();
    }
  });
});
