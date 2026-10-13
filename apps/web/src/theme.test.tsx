import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, applyTheme, readStoredTheme, resolveTheme, useTheme } from "./theme";
import { click, getByText, render } from "./test-utils";

function stubMatchMedia(dark: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: dark,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe("theme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("applies the dark class", () => {
    stubMatchMedia(false);
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("resolves system from the OS preference", () => {
    stubMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
    stubMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("defaults to dark and persists the choice", () => {
    stubMatchMedia(false);
    function Toggle() {
      const { theme, setTheme } = useTheme();
      return <button onClick={() => setTheme("light")}>current:{theme}</button>;
    }
    const { container, unmount } = render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    try {
      // No stored choice: dark is the default.
      expect(getByText(container, "current:dark")).toBeTruthy();
      click(getByText(container, "current:dark"));
      expect(window.localStorage.getItem("opendungen.theme")).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(readStoredTheme()).toBe("light");
    } finally {
      unmount();
    }
  });
});
