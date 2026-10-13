// Logical routes without a router library: the view is parsed from the
// URL, navigation is pushState + popstate, and every view reads the same
// context. Deliberately no react-router — six views don't justify one.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type View =
  | { name: "setup" }
  | { name: "login" }
  | { name: "wizard"; step: 1 | 2 | 3 }
  | { name: "home" }
  | { name: "stories" }
  | { name: "story"; id: string }
  | { name: "scenarios" }
  | { name: "scenario-new" }
  | { name: "scenario-new-name" }
  | { name: "scenario"; id: string }
  | { name: "providers" }
  | { name: "settings" }
  | { name: "not-found" };

export function parsePath(path: string): View {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) {
    // / renders the Home view (see views/home.tsx) instead of
    // listing stories.
    return { name: "home" };
  }
  const [first, second] = parts;
  if (first === "setup" && parts.length === 1) {
    return { name: "setup" };
  }
  if (first === "login" && parts.length === 1) {
    return { name: "login" };
  }
  if (first === "wizard" && parts.length === 2 && second?.startsWith("step-")) {
    const step = Number(second.slice("step-".length));
    if (step === 1 || step === 2 || step === 3) {
      return { name: "wizard", step };
    }
    return { name: "not-found" };
  }
  if (first === "stories" && parts.length === 1) {
    return { name: "stories" };
  }
  if (first === "stories" && parts.length === 2 && second) {
    return { name: "story", id: decodeURIComponent(second) };
  }
  if (first === "scenarios" && parts.length === 1) {
    return { name: "scenarios" };
  }
  if (first === "scenarios" && second === "new" && parts.length === 2) {
    return { name: "scenario-new" };
  }
  if (first === "scenarios" && second === "new" && parts[2] === "name" && parts.length === 3) {
    return { name: "scenario-new-name" };
  }
  if (first === "scenarios" && parts.length === 2 && second) {
    return { name: "scenario", id: decodeURIComponent(second) };
  }
  if (first === "providers" && parts.length === 1) {
    return { name: "providers" };
  }
  if (first === "settings" && parts.length === 1) {
    return { name: "settings" };
  }
  return { name: "not-found" };
}

export function viewPath(view: View): string {
  switch (view.name) {
    case "setup":
      return "/setup";
    case "login":
      return "/login";
    case "wizard":
      return `/wizard/step-${view.step}`;
    case "home":
      return "/";
    case "stories":
      return "/stories";
    case "story":
      return `/stories/${encodeURIComponent(view.id)}`;
    case "scenarios":
      return "/scenarios";
    case "scenario-new":
      return "/scenarios/new";
    case "scenario-new-name":
      return "/scenarios/new/name";
    case "scenario":
      return `/scenarios/${encodeURIComponent(view.id)}`;
    case "providers":
      return "/providers";
    case "settings":
      return "/settings";
    case "not-found":
      return "/";
  }
}

// Usable outside React (the query client's global 401 handler).
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const LocationContext = createContext<string>("/");

export function LocationProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return <LocationContext.Provider value={path}>{children}</LocationContext.Provider>;
}

export function useLocation(): View {
  return parsePath(useContext(LocationContext));
}

export function usePathname(): string {
  return useContext(LocationContext);
}
