import { describe, expect, it } from "vitest";
import { navigate, parsePath, viewPath } from "./location";

describe("parsePath", () => {
  it("parses every logical route", () => {
    expect(parsePath("/")).toEqual({ name: "home" });
    expect(parsePath("/setup")).toEqual({ name: "setup" });
    expect(parsePath("/login")).toEqual({ name: "login" });
    expect(parsePath("/wizard/step-1")).toEqual({ name: "wizard", step: 1 });
    expect(parsePath("/wizard/step-3")).toEqual({ name: "wizard", step: 3 });
    expect(parsePath("/wizard/step-4")).toEqual({ name: "not-found" });
    expect(parsePath("/stories")).toEqual({ name: "stories" });
    expect(parsePath("/stories/abc-123")).toEqual({ name: "story", id: "abc-123" });
    expect(parsePath("/scenarios")).toEqual({ name: "scenarios" });
    expect(parsePath("/scenarios/new")).toEqual({ name: "scenario-new" });
    expect(parsePath("/scenarios/new/name")).toEqual({ name: "scenario-new-name" });
    expect(parsePath("/scenarios/fantasy")).toEqual({ name: "scenario", id: "fantasy" });
    expect(parsePath("/providers")).toEqual({ name: "providers" });
    expect(parsePath("/settings")).toEqual({ name: "settings" });
  });

  it("rejects bad wizard steps and unknown paths", () => {
    expect(parsePath("/wizard/step-9")).toEqual({ name: "not-found" });
    expect(parsePath("/wizard/step-4")).toEqual({ name: "not-found" });
    expect(parsePath("/wizard")).toEqual({ name: "not-found" });
    expect(parsePath("/nope")).toEqual({ name: "not-found" });
    expect(parsePath("/stories/a/b")).toEqual({ name: "not-found" });
    expect(parsePath("/scenarios/new/extra")).toEqual({ name: "not-found" });
  });

  it("round-trips through viewPath", () => {
    const paths = [
      "/setup",
      "/login",
      "/wizard/step-2",
      "/stories",
      "/stories/x1",
      "/scenarios",
      "/scenarios/new",
      "/scenarios/new/name",
      "/scenarios/y2",
      "/providers",
      "/settings",
    ];
    for (const path of paths) {
      expect(viewPath(parsePath(path))).toBe(path);
    }
  });
});

describe("navigate", () => {
  it("pushes state and notifies popstate listeners", () => {
    const seen: string[] = [];
    const onPop = () => seen.push(window.location.pathname);
    window.addEventListener("popstate", onPop);
    try {
      navigate("/providers");
      expect(window.location.pathname).toBe("/providers");
      expect(seen).toEqual(["/providers"]);
      navigate("/stories");
      expect(seen).toEqual(["/providers", "/stories"]);
    } finally {
      window.removeEventListener("popstate", onPop);
    }
  });
});
