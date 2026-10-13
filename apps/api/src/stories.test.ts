import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { hashPassword } from "./auth/password";
import { users } from "./db/schema";
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

// Creates a second user directly in the DB (single mode only ever has one
// user via the API) and logs them in through the real login endpoint.
async function setupSecondUser(
  app: App,
  db: ReturnType<typeof import("./db.local").getLocalDb>,
): Promise<string> {
  await db.insert(users).values({
    id: "user-b",
    email: "b@example.com",
    passwordHash: hashPassword("second-user-password"),
    instanceAdmin: 0,
    createdAt: Date.now(),
  });
  const login = await json(app, "POST", "/api/auth/login", {
    email: "b@example.com",
    password: "second-user-password",
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("expected a Set-Cookie header");
  }
  return setCookie.split(";")[0];
}

describe("stories", () => {
  it("requires auth in single mode", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/stories");
    expect(res.status).toBe(401);
  });

  it("creates, lists, patches, and soft-deletes", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "My Story",
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as {
      story: { id: string; title: string; aiInstructions: string };
    };
    expect(story.title).toBe("My Story");
    expect(story.aiInstructions).toBe("");

    const list = await json(app, "GET", "/api/stories", undefined, cookie);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { stories: unknown[] }).stories).toHaveLength(1);

    const patched = await json(
      app,
      "PATCH",
      `/api/stories/${story.id}`,
      {
        title: "Renamed",
        memory: "The well is dry.",
      },
      cookie,
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      story: { title: string; memory: string };
    };
    expect(patchedBody.story.title).toBe("Renamed");
    expect(patchedBody.story.memory).toBe("The well is dry.");

    const fetched = await json(app, "GET", `/api/stories/${story.id}`, undefined, cookie);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()) as { cards: unknown[] }).toMatchObject({
      cards: [],
    });

    const deleted = await json(app, "DELETE", `/api/stories/${story.id}`, undefined, cookie);
    expect(deleted.status).toBe(200);

    const after = await json(app, "GET", "/api/stories", undefined, cookie);
    expect(((await after.json()) as { stories: unknown[] }).stories).toHaveLength(0);

    const gone = await json(app, "GET", `/api/stories/${story.id}`, undefined, cookie);
    expect(gone.status).toBe(404);
  });

  it("creates a story from a seeded builtin scenario", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "Waystation Tale",
        scenarioId: "builtin-fantasy-waystation",
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as {
      story: { id: string; scenarioId: string };
    };
    expect(story.scenarioId).toBe("builtin-fantasy-waystation");

    // The scenario's opening is persisted as the first output (idx 0).
    const listed = (await (
      await json(app, "GET", `/api/stories/${story.id}/actions`, undefined, cookie)
    ).json()) as { actions: { idx: number; type: string; text: string }[] };
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0].idx).toBe(0);
    expect(listed.actions[0].type).toBe("output");
    expect(listed.actions[0].text.length).toBeGreaterThan(0);

    const unknown = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "Bad",
        scenarioId: "no-such-scenario",
      },
      cookie,
    );
    expect(unknown.status).toBe(404);
  });

  it("creates a story without a scenario with an empty action log", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Blank" }, cookie);
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as { story: { id: string } };

    const listed = (await (
      await json(app, "GET", `/api/stories/${story.id}/actions`, undefined, cookie)
    ).json()) as { actions: unknown[] };
    expect(listed.actions).toHaveLength(0);
  });

  it("isolates stories between users", async () => {
    const { app, db } = createTestApp();
    const { cookie: cookieA } = await setupAdmin(app);
    const cookieB = await setupSecondUser(app, db);

    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "A's story",
      },
      cookieA,
    );
    const { story } = (await created.json()) as { story: { id: string } };

    const listB = await json(app, "GET", "/api/stories", undefined, cookieB);
    expect(((await listB.json()) as { stories: unknown[] }).stories).toHaveLength(0);

    for (const [method, path] of [
      ["GET", `/api/stories/${story.id}`],
      ["PATCH", `/api/stories/${story.id}`],
      ["DELETE", `/api/stories/${story.id}`],
      ["GET", `/api/stories/${story.id}/actions`],
      ["GET", `/api/stories/${story.id}/cards`],
    ] as const) {
      const res = await json(
        app,
        method,
        path,
        method === "PATCH" ? { title: "x" } : undefined,
        cookieB,
      );
      expect(res.status).toBe(404);
    }

    const stillThere = await json(app, "GET", `/api/stories/${story.id}`, undefined, cookieA);
    expect(stillThere.status).toBe(200);
  });

  it("rejects empty patches and invalid bodies with 400", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/stories",
      {
        title: "T",
      },
      cookie,
    );
    const { story } = (await created.json()) as { story: { id: string } };

    const empty = await json(app, "PATCH", `/api/stories/${story.id}`, {}, cookie);
    expect(empty.status).toBe(400);

    const badAction = await json(
      app,
      "POST",
      `/api/stories/${story.id}/actions`,
      {
        type: "shout",
        text: "hello",
      },
      cookie,
    );
    expect(badAction.status).toBe(400);
  });
});
