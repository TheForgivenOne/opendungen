// App shell (Phase 6): no persistent chrome. Views own their headers;
// the shell provides a global nav drawer (hamburger in each view's
// header), the command palette (Cmd/Ctrl+K), and the toast stack lives
// above it in main.tsx. No router library — nav items push logical
// paths into the location context.

import { createContext, useContext, useState, type ReactNode } from "react";
import { logout } from "./api/auth";
import { runMaintenance } from "./api/settings";
import { navigate, usePathname } from "./location";
import { queryClient, useMe } from "./queries";
import { useTheme } from "./theme";
import { ghostClass } from "./ui";
import { CommandPalette, useCommandPaletteHotkey } from "./command-palette";

const NAV = [
  { path: "/", label: "Home" },
  { path: "/stories", label: "Stories" },
  { path: "/scenarios", label: "Scenarios" },
  { path: "/providers", label: "Providers" },
  { path: "/settings", label: "Settings" },
];

function isActive(pathname: string, item: string): boolean {
  if (item === "/") {
    return pathname === "/";
  }
  return pathname === item || pathname.startsWith(`${item}/`);
}

// Persistent top bar (Phase 6b): primary navigation is always
// visible — the command palette stays a power-user shortcut, not the
// only way around. 40px tall on every app route; the wizard renders
// outside the shell so it never shows the bar.
export function TopBar() {
  const pathname = usePathname();
  const homeActive = isActive(pathname, "/");
  const storiesActive = isActive(pathname, "/stories");
  const scenariosActive = isActive(pathname, "/scenarios");
  const settingsActive = isActive(pathname, "/settings");
  return (
    <nav
      aria-label="Primary"
      className="flex h-10 shrink-0 items-center gap-5 border-b border-border bg-bg px-4"
    >
      <button
        onClick={() => navigate("/")}
        aria-label="Home"
        aria-current={homeActive ? "page" : undefined}
        title="Home"
        className={homeActive ? "text-accent" : "text-text-muted hover:text-text"}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>
      <button
        onClick={() => navigate("/stories")}
        aria-current={storiesActive ? "page" : undefined}
        className={`text-sm ${storiesActive ? "text-accent" : "text-text-muted hover:text-text"}`}
      >
        Stories
      </button>
      <button
        onClick={() => navigate("/scenarios")}
        aria-current={scenariosActive ? "page" : undefined}
        className={`text-sm ${scenariosActive ? "text-accent" : "text-text-muted hover:text-text"}`}
      >
        Scenarios
      </button>
      <span className="flex-1" />
      <button
        onClick={() => navigate("/settings")}
        aria-label="Settings"
        aria-current={settingsActive ? "page" : undefined}
        title="Settings"
        className={`text-base leading-none ${settingsActive ? "text-accent" : "text-text-muted hover:text-text"}`}
      >
        <span aria-hidden="true">⚙</span>
      </button>
    </nav>
  );
}

// Plain page header for the non-story views: hamburger + title +
// optional right-side action. Keeps one navigation affordance
// everywhere without a persistent sidebar.
export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  const { openDrawer } = useShellMenu();
  return (
    <div className="mb-4 flex items-center gap-2">
      <button
        className="rounded px-2 py-1 text-text-muted hover:text-text"
        onClick={openDrawer}
        aria-label="Open menu"
      >
        ☰
      </button>
      <h1 className="flex-1 text-xl font-bold">{title}</h1>
      {action}
    </div>
  );
}

interface ShellMenu {
  openDrawer: () => void;
}

const ShellMenuContext = createContext<ShellMenu>({ openDrawer: () => {} });

// Hamburger buttons in view headers call this to open the nav drawer.
export function useShellMenu(): ShellMenu {
  return useContext(ShellMenuContext);
}

function UserMenu({ onNavigate }: { onNavigate: () => void }) {
  const { data } = useMe();
  const { theme, setTheme } = useTheme();

  async function signOut() {
    try {
      await logout();
    } catch {
      // Cookie may already be gone; still leave.
    }
    queryClient.clear();
    onNavigate();
    navigate("/login");
  }

  async function maintenance() {
    try {
      await runMaintenance();
    } catch {
      // Errors surface on the Settings screen; the drawer just closes.
    }
    onNavigate();
    navigate("/settings");
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
      <span className="truncate px-1 text-text-muted" title={data?.user.email ?? ""}>
        {data?.user.email ?? "Anonymous"}
      </span>
      <div className="flex gap-1" role="group" aria-label="Theme">
        {(["light", "dark", "system"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            aria-pressed={theme === t}
            title={t}
            className={`rounded border px-2 py-1 text-xs ${
              theme === t
                ? "border-accent text-accent"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <button className={ghostClass} onClick={() => void maintenance()}>
        Run maintenance
      </button>
      <button className={ghostClass} onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  useCommandPaletteHotkey(() => setPalette((prev) => !prev));

  function go(path: string) {
    setDrawer(false);
    navigate(path);
  }

  return (
    <ShellMenuContext.Provider value={{ openDrawer: () => setDrawer(true) }}>
      <div className="min-h-screen bg-bg font-sans text-text">
        <TopBar />
        <main className="min-w-0">{children}</main>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-40">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawer(false)}
            role="presentation"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-surface p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-bold">OpenDungen</span>
              <button
                className={ghostClass}
                onClick={() => setDrawer(false)}
                aria-label="Close menu"
              >
                ✕
              </button>
            </div>
            <nav className="flex flex-col gap-1">
              {NAV.map((item) => {
                const active = isActive(pathname, item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => go(item.path)}
                    aria-current={active ? "page" : undefined}
                    className={`rounded px-3 py-2 text-left text-sm ${
                      active
                        ? "bg-surface-hover font-medium text-accent"
                        : "text-text hover:bg-surface-hover"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <button className={`${ghostClass} mt-2`} onClick={() => setPalette(true)}>
              Command palette <span className="font-mono text-xs text-text-muted">⌘K</span>
            </button>
            <div className="mt-auto">
              <UserMenu onNavigate={() => setDrawer(false)} />
            </div>
          </aside>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </ShellMenuContext.Provider>
  );
}
