import { describe, expect, it } from "vitest";
import { assembleContext } from "./context/assemble";
import type { createApp } from "./app";
import { createTestApp, mockProviderFactory, setupAdmin } from "./testing";

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

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) {
        throw new Error(`unparseable SSE block: ${block}`);
      }
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      };
    });
}

interface ActionView {
  id: string;
  idx: number;
  type: string;
  text: string;
}

async function listActions(app: App, storyId: string, cookie: string): Promise<ActionView[]> {
  const res = await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { actions: ActionView[] }).actions;
}

async function setupStoryWithProvider(
  app: App,
  cookie: string,
): Promise<{ storyId: string; providerId: string }> {
  const created = await json(app, "POST", "/api/stories", { title: "Continue Story" }, cookie);
  expect(created.status).toBe(201);
  const { story } = (await created.json()) as { story: { id: string } };
  const provider = await json(
    app,
    "POST",
    "/api/providers",
    {
      label: "mock",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "mock-model",
    },
    cookie,
  );
  expect(provider.status).toBe(201);
  const { provider: prow } = (await provider.json()) as { provider: { id: string } };
  const def = await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);
  expect(def.status).toBe(200);
  return { storyId: story.id, providerId: prow.id };
}

function testApp() {
  return createTestApp("single", {
    env: { allowPrivateProviderUrls: true },
    createProviderFn: mockProviderFactory(),
  });
}

describe("continue generation", () => {
  it("generates an output action with no preceding input", async () => {
    const { app } = testApp();
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { continue: true },
      cookie,
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);

    const meta = events[0].data as { inputActionId: string | null };
    expect(meta.inputActionId).toBeNull();
    const done = events[3].data as { outputActionId: string };
    expect(done.outputActionId).toBeTruthy();

    const actions = await listActions(app, storyId, cookie);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ idx: 0, type: "output", text: "Hello world" });
    expect(actions[0].id).toBe(done.outputActionId);
  });

  it("appends after history without an input row", async () => {
    const { app } = testApp();
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const first = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "open the door" },
      cookie,
    );
    expect(first.status).toBe(200);
    await first.text();

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { continue: true },
      cookie,
    );
    expect(res.status).toBe(200);
    await res.text();

    const actions = await listActions(app, storyId, cookie);
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.type)).toEqual(["input", "output", "output"]);
    expect(actions.map((a) => a.idx)).toEqual([0, 1, 2]);
  });

  it("requires input unless continue is true", async () => {
    const { app } = testApp();
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const res = await json(app, "POST", `/api/stories/${storyId}/generate`, {}, cookie);
    expect(res.status).toBe(400);
  });

  it("retry after continue regenerates the output with no input", async () => {
    const { app } = testApp();
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const continued = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { continue: true },
      cookie,
    );
    expect(continued.status).toBe(200);
    const firstDone = parseSse(await continued.text()).find((e) => e.event === "done")?.data as {
      outputActionId: string;
    };

    const retried = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(retried.status).toBe(200);
    const retryDone = parseSse(await retried.text()).find((e) => e.event === "done")?.data as {
      outputActionId: string;
    };
    expect(retryDone.outputActionId).toBeTruthy();
    expect(retryDone.outputActionId).not.toBe(firstDone.outputActionId);

    const actions = await listActions(app, storyId, cookie);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ idx: 0, type: "output", text: "Hello world" });
  });

  it("undo after continue deletes only the output", async () => {
    const { app } = testApp();
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const first = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "open the door" },
      cookie,
    );
    await first.text();
    const continued = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { continue: true },
      cookie,
    );
    await continued.text();
    expect(await listActions(app, storyId, cookie)).toHaveLength(3);

    const undone = await json(app, "POST", `/api/stories/${storyId}/undo`, undefined, cookie);
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { deleted: number }).deleted).toBe(1);

    const actions = await listActions(app, storyId, cookie);
    expect(actions.map((a) => a.type)).toEqual(["input", "output"]);
  });
});

describe("continue context assembly", () => {
  it("omits the trailing user message when newInput is absent", async () => {
    const { DEFAULT_CONTEXT_BUDGET } = await import("@opendungen/shared");
    const assembled = assembleContext({
      story: { aiInstructions: "be vivid", plotEssentials: "", summary: "", memory: "" },
      actions: [{ idx: 0, type: "output", text: "The door creaks." }],
      cards: [],
      mode: "continue",
      tokenMultiplier: 1,
      budget: DEFAULT_CONTEXT_BUDGET,
      ranges: [],
    });
    const last = assembled.messages[assembled.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("The door creaks.");
    expect(assembled.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });
});

describe("story completion marker", () => {
  it("creates null, patches, lists, and clears completedAt", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const created = await json(app, "POST", "/api/stories", { title: "Completable" }, cookie);
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as {
      story: { id: string; completedAt: number | null };
    };
    expect(story.completedAt).toBeNull();

    const marked = await json(
      app,
      "PATCH",
      `/api/stories/${story.id}`,
      { completedAt: 123456 },
      cookie,
    );
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as { story: { completedAt: number } }).story.completedAt).toBe(
      123456,
    );

    const listed = await json(app, "GET", "/api/stories", undefined, cookie);
    expect(listed.status).toBe(200);
    const stories = ((await listed.json()) as { stories: { completedAt: number }[] }).stories;
    expect(stories).toHaveLength(1);
    expect(stories[0].completedAt).toBe(123456);

    const cleared = await json(
      app,
      "PATCH",
      `/api/stories/${story.id}`,
      { completedAt: null },
      cookie,
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { story: { completedAt: number | null } }).story.completedAt,
    ).toBeNull();
  });
});
