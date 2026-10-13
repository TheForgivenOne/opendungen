import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { createTestApp, setupAdmin } from "./testing";

type App = ReturnType<typeof createApp>;

async function json(app: App, method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers["cookie"] = cookie;
  }
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("scenarios", () => {
  it("requires auth in single mode", async () => {
    const { app } = createTestApp();
    const list = await json(app, "GET", "/api/scenarios");
    expect(list.status).toBe(401);
    const detail = await json(app, "GET", "/api/scenarios/builtin-fantasy-waystation");
    expect(detail.status).toBe(401);
  });

  it("lists all scenarios without opening or aiInstructions", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await json(app, "GET", "/api/scenarios", undefined, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenarios: {
        id: string;
        title: string;
        description: string;
        tags: string[];
        builtin: boolean;
        opening?: unknown;
        aiInstructions?: unknown;
      }[];
    };
    expect(body.scenarios).toHaveLength(3);
    for (const scenario of body.scenarios) {
      expect(Object.keys(scenario).sort()).toEqual(
        ["builtin", "description", "id", "tags", "title"].sort(),
      );
      expect(Array.isArray(scenario.tags)).toBe(true);
      expect(scenario.builtin).toBe(true);
    }
    expect(body.scenarios.map((s) => s.id).sort()).toEqual([
      "builtin-fantasy-waystation",
      "builtin-mystery-hollow-creek",
      "builtin-scifi-derelict",
    ]);
  });

  it("returns full detail for one scenario", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await json(
      app,
      "GET",
      "/api/scenarios/builtin-fantasy-waystation",
      undefined,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenario: {
        id: string;
        title: string;
        description: string;
        opening: string;
        aiInstructions: string;
        tags: string[];
        builtin: boolean;
      };
    };
    expect(body.scenario.id).toBe("builtin-fantasy-waystation");
    expect(body.scenario.title.length).toBeGreaterThan(0);
    expect(body.scenario.description.length).toBeGreaterThan(0);
    expect(body.scenario.opening.length).toBeGreaterThan(0);
    expect(body.scenario.aiInstructions.length).toBeGreaterThan(0);
    expect(body.scenario.builtin).toBe(true);
  });

  it("returns 404 for an unknown scenario", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await json(app, "GET", "/api/scenarios/no-such-scenario", undefined, cookie);
    expect(res.status).toBe(404);
  });

  it("is open without auth in none mode", async () => {
    const { app } = createTestApp("none");
    const res = await json(app, "GET", "/api/scenarios");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenarios: unknown[] };
    expect(body.scenarios).toHaveLength(3);
  });
});
