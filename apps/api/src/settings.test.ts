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

async function authedApp(): Promise<{ app: App; cookie: string }> {
  const { app } = createTestApp();
  const { cookie } = await setupAdmin(app);
  return { app, cookie };
}

describe("settings", () => {
  it("reports instance settings", async () => {
    const { app, cookie } = await authedApp();
    const res = await json(app, "GET", "/api/settings/instance", undefined, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authMode: string;
      version: string;
      hasSessionSecret: boolean;
      setupComplete: boolean;
    };
    expect(body.authMode).toBe("single");
    expect(body.version).toBe("0.0.0");
    expect(body.hasSessionSecret).toBe(true);
    expect(body.setupComplete).toBe(true);
  });

  it("reports instance settings in none mode", async () => {
    const { app } = createTestApp("none");
    const res = await json(app, "GET", "/api/settings/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authMode: string;
      version: string;
      setupComplete: boolean;
    };
    expect(body.authMode).toBe("none");
    expect(body.version).toBe("0.0.0");
    // requireAuth lazily provisions the instance admin first.
    expect(body.setupComplete).toBe(true);
  });

  it("requires auth for settings endpoints", async () => {
    const { app } = createTestApp();
    expect((await json(app, "GET", "/api/settings/instance")).status).toBe(401);
    expect((await json(app, "GET", "/api/settings/account")).status).toBe(401);
    expect((await json(app, "POST", "/api/auth/logout-all")).status).toBe(401);
  });

  it("reports account info with zero counts, then real counts", async () => {
    const { app, cookie } = await authedApp();
    const empty = (await (
      await json(app, "GET", "/api/settings/account", undefined, cookie)
    ).json()) as {
      user: { email: string; instanceAdmin: boolean; createdAt: number };
      counts: { stories: number; actions: number; ranges: number };
    };
    expect(empty.user.email).toBe("admin@example.com");
    expect(empty.user.instanceAdmin).toBe(true);
    expect(empty.user.createdAt).toBeGreaterThan(0);
    expect(empty.counts).toEqual({ stories: 0, actions: 0, ranges: 0 });

    const created = (await (
      await json(app, "POST", "/api/stories", { title: "Counted" }, cookie)
    ).json()) as { story: { id: string } };
    await json(
      app,
      "POST",
      `/api/stories/${created.story.id}/actions`,
      {
        type: "input",
        text: "hello",
      },
      cookie,
    );
    await json(
      app,
      "POST",
      `/api/stories/${created.story.id}/actions`,
      {
        type: "output",
        text: "hi",
      },
      cookie,
    );

    const full = (await (
      await json(app, "GET", "/api/settings/account", undefined, cookie)
    ).json()) as { counts: { stories: number; actions: number; ranges: number } };
    expect(full.counts).toEqual({ stories: 1, actions: 2, ranges: 0 });
  });

  it("logout-all revokes the session", async () => {
    const { app, cookie } = await authedApp();
    const res = await json(app, "POST", "/api/auth/logout-all", undefined, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // The old cookie no longer authenticates.
    const after = await json(app, "GET", "/api/settings/account", undefined, cookie);
    expect(after.status).toBe(401);
    const stories = await json(app, "GET", "/api/stories", undefined, cookie);
    expect(stories.status).toBe(401);
  });
});
