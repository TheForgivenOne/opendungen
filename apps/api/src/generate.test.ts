import { describe, expect, it } from "vitest";
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

// hono writeSSE frames: "event: <name>\ndata: <json>\n\n".
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

async function setupStoryWithProvider(
  app: App,
  cookie: string,
): Promise<{ storyId: string; providerId: string }> {
  const created = await json(app, "POST", "/api/stories", { title: "Gen Story" }, cookie);
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

describe("generation", () => {
  it("streams meta/delta/done and persists both actions", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "look" },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);

    const meta = events[0].data as {
      usage: { total: number };
      cardsInjected: string[];
      inputActionId: string;
    };
    expect(meta.usage.total).toBeGreaterThan(0);
    expect(meta.cardsInjected).toEqual([]);
    const done = events[3].data as { outputActionId: string };
    expect(done.outputActionId).toBeTruthy();
    expect((events[1].data as { text: string }).text).toBe("Hello");
    expect((events[2].data as { text: string }).text).toBe(" world");

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { idx: number; type: string; text: string; id: string }[] };
    expect(listed.actions).toHaveLength(2);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "look" });
    expect(listed.actions[1]).toMatchObject({ idx: 1, type: "output", text: "Hello world" });
    expect(listed.actions[0].id).toBe(meta.inputActionId);
    expect(listed.actions[1].id).toBe(done.outputActionId);
  });

  it("returns 400 when no provider is configured", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "No Prov" }, cookie);
    const { story } = (await created.json()) as { story: { id: string } };
    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/generate`,
      { input: "hi" },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_provider");
  });

  it("sends an error event and persists only the input on provider failure", async () => {
    const { ProviderError } = await import("./llm/types");
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory({ error: new ProviderError("auth", "bad key") }),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "hi" },
      cookie,
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("meta");
    expect(kinds[kinds.length - 1]).toBe("error");
    expect(events[kinds.length - 1].data).toMatchObject({ code: "auth" });

    // The input is already persisted (a lone input the user can retry);
    // no output row exists.
    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { idx: number; type: string; text: string }[] };
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "hi" });
  });

  it("sends empty_completion and persists no output when the stream is twice empty", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory({ chunks: [] }),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "hi" },
      cookie,
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("meta");
    expect(kinds[kinds.length - 1]).toBe("error");
    expect(events[kinds.length - 1].data).toMatchObject({
      code: "empty_completion",
      message: "The model returned no output. Try again.",
    });

    // The input stays persisted; no empty output row exists.
    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { idx: number; type: string; text: string }[] };
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "hi" });
  });

  it("retry deletes the old output first and regenerates", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const first = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "open it" },
      cookie,
    );
    const firstEvents = parseSse(await first.text());
    const oldOutputId = (firstEvents[firstEvents.length - 1].data as { outputActionId: string })
      .outputActionId;

    const retry = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(retry.status).toBe(200);
    const events = parseSse(await retry.text());
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { id: string; idx: number; type: string; text: string }[] };
    // Still exactly one input + one output: no history of the attempt.
    expect(listed.actions).toHaveLength(2);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "open it" });
    expect(listed.actions[1]).toMatchObject({ idx: 1, type: "output", text: "Hello world" });
    expect(listed.actions[1].id).not.toBe(oldOutputId);
  });

  it("retry 409s on an empty story but regenerates a lone input", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const empty = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(empty.status).toBe(409);

    // A lone input (an errored turn) retries without deleting anything.
    const manual = (await (
      await json(
        app,
        "POST",
        `/api/stories/${storyId}/actions`,
        { type: "input", text: "manual" },
        cookie,
      )
    ).json()) as { action: { id: string } };
    const retry = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(retry.status).toBe(200);
    const events = parseSse(await retry.text());
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);
    expect((events[0].data as { inputActionId: string }).inputActionId).toBe(manual.action.id);

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { id: string; idx: number; type: string; text: string }[] };
    expect(listed.actions).toHaveLength(2);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "manual" });
    expect(listed.actions[0].id).toBe(manual.action.id);
    expect(listed.actions[1]).toMatchObject({ idx: 1, type: "output", text: "Hello world" });
  });

  it("undo deletes the last pair, then a lone input, then 409s", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const none = await json(app, "POST", `/api/stories/${storyId}/undo`, undefined, cookie);
    expect(none.status).toBe(409);

    await json(app, "POST", `/api/stories/${storyId}/generate`, { input: "go" }, cookie).then(
      (res) => res.text(),
    );
    const undone = await json(app, "POST", `/api/stories/${storyId}/undo`, undefined, cookie);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({ deleted: 2 });

    await json(
      app,
      "POST",
      `/api/stories/${storyId}/actions`,
      { type: "input", text: "aborted leftover" },
      cookie,
    );
    const undoneOne = await json(app, "POST", `/api/stories/${storyId}/undo`, undefined, cookie);
    expect(await undoneOne.json()).toEqual({ deleted: 1 });

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: unknown[] };
    expect(listed.actions).toHaveLength(0);
  });

  it("edit updates action text in place", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    await json(app, "POST", `/api/stories/${storyId}/generate`, { input: "original" }, cookie).then(
      (res) => res.text(),
    );
    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { id: string; idx: number; type: string }[] };
    const target = listed.actions[1];

    const edited = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}/actions/${target.id}`,
      { text: "edited narration" },
      cookie,
    );
    expect(edited.status).toBe(200);
    expect(
      ((await edited.json()) as { action: { text: string; idx: number } }).action,
    ).toMatchObject({ text: "edited narration", idx: 1 });

    const missing = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}/actions/does-not-exist`,
      { text: "x" },
      cookie,
    );
    expect(missing.status).toBe(404);

    const empty = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}/actions/${target.id}`,
      { text: "" },
      cookie,
    );
    expect(empty.status).toBe(400);
  });
});
