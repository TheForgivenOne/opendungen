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

// Second user straight in the DB (single mode only ever has one user via
// the API), logged in through the real login endpoint.
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

const SHOUT = 'if (typeof text === "string" && text.includes("SHOUT")) text = text.toUpperCase();';

describe("story scripts", () => {
  it("requires auth in single mode", async () => {
    const { app } = createTestApp();
    const res = await json(app, "GET", "/api/stories/whatever/scripts");
    expect(res.status).toBe(401);
  });

  it("creates, lists, patches, and deletes story scripts", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Scripted" }, cookie);
    const { story } = (await created.json()) as { story: { id: string } };

    const empty = await json(app, "GET", `/api/stories/${story.id}/scripts`, undefined, cookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ scripts: [], readOnly: false });

    const first = await json(
      app,
      "POST",
      `/api/stories/${story.id}/scripts`,
      { name: "shout", source: SHOUT, position: 2 },
      cookie,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      script: { id: string; storyId: string; scenarioId: null; enabled: boolean; position: number };
    };
    expect(firstBody.script).toMatchObject({
      storyId: story.id,
      scenarioId: null,
      enabled: true,
      position: 2,
    });
    const firstId = firstBody.script.id;

    const second = await json(
      app,
      "POST",
      `/api/stories/${story.id}/scripts`,
      { name: "early", source: "text;", enabled: false, position: 0 },
      cookie,
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { script: { id: string } };

    // Listed in position order.
    const listed = (await (
      await json(app, "GET", `/api/stories/${story.id}/scripts`, undefined, cookie)
    ).json()) as { scripts: { id: string; name: string }[] };
    expect(listed.scripts.map((s) => s.name)).toEqual(["early", "shout"]);

    const patched = await json(
      app,
      "PATCH",
      `/api/scripts/${firstId}`,
      { enabled: false, position: 5 },
      cookie,
    );
    expect(patched.status).toBe(200);
    expect(
      ((await patched.json()) as { script: { enabled: boolean; position: number } }).script,
    ).toMatchObject({ enabled: false, position: 5 });

    const deleted = await json(
      app,
      "DELETE",
      `/api/scripts/${secondBody.script.id}`,
      undefined,
      cookie,
    );
    expect(deleted.status).toBe(200);
    const after = (await (
      await json(app, "GET", `/api/stories/${story.id}/scripts`, undefined, cookie)
    ).json()) as { scripts: unknown[] };
    expect(after.scripts).toHaveLength(1);

    const missingStory = await json(app, "GET", "/api/stories/nope/scripts", undefined, cookie);
    expect(missingStory.status).toBe(404);
    const missingScript = await json(app, "PATCH", "/api/scripts/nope", { name: "x" }, cookie);
    expect(missingScript.status).toBe(404);
    const emptyPatch = await json(app, "PATCH", `/api/scripts/${firstId}`, {}, cookie);
    expect(emptyPatch.status).toBe(400);
  });

  it("isolates story scripts between users", async () => {
    const { app, db } = createTestApp();
    const { cookie: cookieA } = await setupAdmin(app);
    const cookieB = await setupSecondUser(app, db);

    const created = await json(app, "POST", "/api/stories", { title: "A's story" }, cookieA);
    const { story } = (await created.json()) as { story: { id: string } };
    const script = await json(
      app,
      "POST",
      `/api/stories/${story.id}/scripts`,
      { name: "mine", source: "text;" },
      cookieA,
    );
    const { script: row } = (await script.json()) as { script: { id: string } };

    expect(
      (await json(app, "GET", `/api/stories/${story.id}/scripts`, undefined, cookieB)).status,
    ).toBe(404);
    expect(
      (
        await json(
          app,
          "POST",
          `/api/stories/${story.id}/scripts`,
          { name: "x", source: "y;" },
          cookieB,
        )
      ).status,
    ).toBe(404);
    expect(
      (await json(app, "PATCH", `/api/scripts/${row.id}`, { name: "x" }, cookieB)).status,
    ).toBe(404);
    expect((await json(app, "DELETE", `/api/scripts/${row.id}`, undefined, cookieB)).status).toBe(
      404,
    );
    // Still intact for the owner.
    expect(
      (await (
        await json(app, "GET", `/api/stories/${story.id}/scripts`, undefined, cookieA)
      ).json()) as { scripts: unknown[] },
    ).toMatchObject({ scripts: [{ id: row.id }] });
  });
});

describe("scenario scripts", () => {
  it("lists builtin scenario scripts as read-only and manages them", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const listed = await json(
      app,
      "GET",
      "/api/scenarios/builtin-fantasy-waystation/scripts",
      undefined,
      cookie,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ scripts: [], readOnly: true });

    const created = await json(
      app,
      "POST",
      "/api/scenarios/builtin-fantasy-waystation/scripts",
      { name: "lore", source: "text;", position: 1 },
      cookie,
    );
    expect(created.status).toBe(201);
    const { script } = (await created.json()) as {
      script: { id: string; storyId: null; scenarioId: string };
    };
    expect(script).toMatchObject({ storyId: null, scenarioId: "builtin-fantasy-waystation" });

    const relisted = (await (
      await json(app, "GET", "/api/scenarios/builtin-fantasy-waystation/scripts", undefined, cookie)
    ).json()) as { scripts: { id: string }[]; readOnly: boolean };
    expect(relisted.scripts.map((s) => s.id)).toEqual([script.id]);
    expect(relisted.readOnly).toBe(true);

    const patched = await json(
      app,
      "PATCH",
      `/api/scripts/${script.id}`,
      { name: "lore2" },
      cookie,
    );
    expect(patched.status).toBe(200);

    const deleted = await json(app, "DELETE", `/api/scripts/${script.id}`, undefined, cookie);
    expect(deleted.status).toBe(200);

    const missing = await json(app, "GET", "/api/scenarios/nope/scripts", undefined, cookie);
    expect(missing.status).toBe(404);
  });
});

describe("validate endpoint", () => {
  it("accepts valid scripts and rejects syntax errors", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const anon = await json(app, "POST", "/api/scripts/validate", { source: "text;" });
    expect(anon.status).toBe(401);

    const ok = await json(app, "POST", "/api/scripts/validate", { source: SHOUT }, cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const bad = await json(
      app,
      "POST",
      "/api/scripts/validate",
      { source: "function broken( {" },
      cookie,
    );
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { ok: boolean; error?: string };
    expect(badBody.ok).toBe(false);
    expect(badBody.error).toBeTruthy();

    const empty = await json(app, "POST", "/api/scripts/validate", { source: "" }, cookie);
    expect(empty.status).toBe(400);
  });
});
