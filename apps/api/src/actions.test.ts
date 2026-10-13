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

describe("actions", () => {
  it("appends actions with server-assigned monotonic idx", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "S",
      },
      cookie,
    );
    const { story } = (await created.json()) as { story: { id: string } };

    for (const [i, type] of ["input", "output", "continue"].entries()) {
      const res = await json(
        app,
        "POST",
        `/api/stories/${story.id}/actions`,
        {
          type,
          text: `action ${i}`,
        },
        cookie,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { action: { idx: number } };
      expect(body.action.idx).toBe(i);
    }

    const list = await json(app, "GET", `/api/stories/${story.id}/actions`, undefined, cookie);
    expect(list.status).toBe(200);
    const items = (
      (await list.json()) as {
        actions: { idx: number; type: string; text: string }[];
      }
    ).actions;
    expect(items.map((a) => a.idx)).toEqual([0, 1, 2]);
    expect(items.map((a) => a.type)).toEqual(["input", "output", "continue"]);
  });

  it("two sequential appends do not collide on idx", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "S",
      },
      cookie,
    );
    const { story } = (await created.json()) as { story: { id: string } };

    const first = await json(
      app,
      "POST",
      `/api/stories/${story.id}/actions`,
      {
        type: "input",
        text: "first",
      },
      cookie,
    );
    const second = await json(
      app,
      "POST",
      `/api/stories/${story.id}/actions`,
      {
        type: "input",
        text: "second",
      },
      cookie,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = (await first.json()) as { action: { idx: number } };
    const b = (await second.json()) as { action: { idx: number } };
    expect([a.action.idx, b.action.idx].sort()).toEqual([0, 1]);
  });

  it("appends to missing, foreign, or deleted stories 404", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const missing = await json(
      app,
      "POST",
      "/api/stories/nope/actions",
      {
        type: "input",
        text: "x",
      },
      cookie,
    );
    expect(missing.status).toBe(404);

    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "S",
      },
      cookie,
    );
    const { story } = (await created.json()) as { story: { id: string } };
    await json(app, "DELETE", `/api/stories/${story.id}`, undefined, cookie);

    const deleted = await json(
      app,
      "POST",
      `/api/stories/${story.id}/actions`,
      {
        type: "input",
        text: "x",
      },
      cookie,
    );
    expect(deleted.status).toBe(404);
    const listDeleted = await json(
      app,
      "GET",
      `/api/stories/${story.id}/actions`,
      undefined,
      cookie,
    );
    expect(listDeleted.status).toBe(404);
  });
});
