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

describe("story cards", () => {
  it("supports basic CRUD scoped to the owning story", async () => {
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

    const empty = await json(app, "GET", `/api/stories/${story.id}/cards`, undefined, cookie);
    expect(((await empty.json()) as { cards: unknown[] }).cards).toEqual([]);

    const added = await json(
      app,
      "POST",
      `/api/stories/${story.id}/cards`,
      {
        keys: ["well", "water"],
        entry: "The well has been dry for years.",
      },
      cookie,
    );
    expect(added.status).toBe(201);
    const { card } = (await added.json()) as {
      card: { id: string; keys: string[]; entry: string; enabled: boolean };
    };
    expect(card.keys).toEqual(["well", "water"]);
    expect(card.enabled).toBe(true);

    const patched = await json(
      app,
      "PATCH",
      `/api/stories/${story.id}/cards/${card.id}`,
      {
        entry: "The well water is black.",
        enabled: false,
      },
      cookie,
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      card: { entry: string; enabled: boolean };
    };
    expect(patchedBody.card.entry).toBe("The well water is black.");
    expect(patchedBody.card.enabled).toBe(false);

    const removed = await json(
      app,
      "DELETE",
      `/api/stories/${story.id}/cards/${card.id}`,
      undefined,
      cookie,
    );
    expect(removed.status).toBe(200);

    const after = await json(app, "GET", `/api/stories/${story.id}/cards`, undefined, cookie);
    expect(((await after.json()) as { cards: unknown[] }).cards).toEqual([]);

    const repatch = await json(
      app,
      "PATCH",
      `/api/stories/${story.id}/cards/${card.id}`,
      {
        entry: "gone",
      },
      cookie,
    );
    expect(repatch.status).toBe(404);
  });

  it("rejects invalid card bodies with 400", async () => {
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

    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/cards`,
      {
        keys: [],
        entry: "",
      },
      cookie,
    );
    expect(res.status).toBe(400);
  });
});
