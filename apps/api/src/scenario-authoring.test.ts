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

const FORM = {
  title: "My Scenario",
  description: "A test scenario",
  opening: "You wake up.",
  aiInstructions: "Be kind.",
  tags: ["test", "cozy"],
};

describe("scenario authoring", () => {
  it("creates, edits and deletes a user scenario", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const created = await json(app, "POST", "/api/scenarios", FORM, cookie);
    expect(created.status).toBe(201);
    const { scenario } = (await created.json()) as {
      scenario: { id: string; title: string; builtin: boolean; tags: string[] };
    };
    expect(scenario.builtin).toBe(false);
    expect(scenario.tags).toEqual(["test", "cozy"]);

    const patched = await json(
      app,
      "PATCH",
      `/api/scenarios/${scenario.id}`,
      { title: "Renamed", tags: ["solo"] },
      cookie,
    );
    expect(patched.status).toBe(200);
    const { scenario: edited } = (await patched.json()) as {
      scenario: { title: string; tags: string[]; opening: string };
    };
    expect(edited.title).toBe("Renamed");
    expect(edited.tags).toEqual(["solo"]);
    expect(edited.opening).toBe("You wake up.");

    const deleted = await json(app, "DELETE", `/api/scenarios/${scenario.id}`, undefined, cookie);
    expect(deleted.status).toBe(200);
    const gone = await json(app, "GET", `/api/scenarios/${scenario.id}`, undefined, cookie);
    expect(gone.status).toBe(404);
  });

  it("403s builtin edit and delete", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const id = "builtin-fantasy-waystation";

    const patched = await json(app, "PATCH", `/api/scenarios/${id}`, { title: "Nope" }, cookie);
    expect(patched.status).toBe(403);
    const deleted = await json(app, "DELETE", `/api/scenarios/${id}`, undefined, cookie);
    expect(deleted.status).toBe(403);
    // Builtin untouched.
    const detail = await json(app, "GET", `/api/scenarios/${id}`, undefined, cookie);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { scenario: { title: string } }).scenario.title).toBe(
      "Embers of the Waystation",
    );
  });

  it("duplicates a builtin into an editable user copy", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const dup = await json(
      app,
      "POST",
      "/api/scenarios/builtin-fantasy-waystation/duplicate",
      undefined,
      cookie,
    );
    expect(dup.status).toBe(201);
    const { scenario: copy } = (await dup.json()) as {
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
    expect(copy.id).not.toBe("builtin-fantasy-waystation");
    expect(copy.builtin).toBe(false);
    const original = (await (
      await json(app, "GET", "/api/scenarios/builtin-fantasy-waystation", undefined, cookie)
    ).json()) as { scenario: typeof copy };
    expect(copy.title).toBe(original.scenario.title);
    expect(copy.description).toBe(original.scenario.description);
    expect(copy.opening).toBe(original.scenario.opening);
    expect(copy.aiInstructions).toBe(original.scenario.aiInstructions);
    expect(copy.tags).toEqual(original.scenario.tags);

    // The copy is editable.
    const patched = await json(
      app,
      "PATCH",
      `/api/scenarios/${copy.id}`,
      { title: "My Waystation" },
      cookie,
    );
    expect(patched.status).toBe(200);

    const missing = await json(app, "POST", "/api/scenarios/nope/duplicate", undefined, cookie);
    expect(missing.status).toBe(404);
  });

  it("lists builtins and user-owned scenarios together", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    await json(app, "POST", "/api/scenarios", { ...FORM, tags: [] }, cookie);

    const res = await json(app, "GET", "/api/scenarios", undefined, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenarios: { id: string; title: string; builtin: boolean; opening?: unknown }[];
    };
    expect(body.scenarios).toHaveLength(4);
    const mine = body.scenarios.filter((s) => !s.builtin);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("My Scenario");
    for (const s of body.scenarios) {
      expect(s.opening).toBeUndefined();
    }
  });

  it("unlinks stories when their scenario is deleted", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/scenarios", FORM, cookie);
    const { scenario } = (await created.json()) as { scenario: { id: string } };
    const story = await json(
      app,
      "POST",
      "/api/stories",
      { title: "Linked", scenarioId: scenario.id },
      cookie,
    );
    expect(story.status).toBe(201);
    const { story: storyRow } = (await story.json()) as { story: { id: string } };

    const deleted = await json(app, "DELETE", `/api/scenarios/${scenario.id}`, undefined, cookie);
    expect(deleted.status).toBe(200);
    const fetched = await json(app, "GET", `/api/stories/${storyRow.id}`, undefined, cookie);
    expect(fetched.status).toBe(200);
    expect(
      ((await fetched.json()) as { story: { scenarioId: string | null } }).story.scenarioId,
    ).toBe(null);
  });

  it("validates create and patch bodies", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const empty = await json(app, "POST", "/api/scenarios", { ...FORM, title: "" }, cookie);
    expect(empty.status).toBe(400);
    const created = await json(app, "POST", "/api/scenarios", FORM, cookie);
    const { scenario } = (await created.json()) as { scenario: { id: string } };
    const noFields = await json(app, "PATCH", `/api/scenarios/${scenario.id}`, {}, cookie);
    expect(noFields.status).toBe(400);
  });
});
