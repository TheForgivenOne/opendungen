import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { appendAction } from "./action-log";
import { compressedRanges, stories, users } from "./db/schema";
import { AbortError, type LLMProvider, type LLMRequest } from "./llm/types";
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

// Provider double that answers narrative calls with fixed chunks and
// compressor calls (maxTokens 600 + compressor system prompt) with a
// configurable response. Records every request it receives.
function createScriptedProvider() {
  const calls: LLMRequest[] = [];
  const compressor = { text: '{"shouldCompress": false}', error: null as Error | null };
  const provider: LLMProvider = {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    async *complete(req: LLMRequest, signal: AbortSignal) {
      calls.push(req);
      const isCompressor =
        req.maxTokens === 600 &&
        (req.messages[0]?.content ?? "").includes("story compression engine");
      if (isCompressor && compressor.error) {
        throw compressor.error;
      }
      const chunks = isCompressor ? [compressor.text] : ["Hello", " world"];
      for (const delta of chunks) {
        if (signal.aborted) {
          throw new AbortError();
        }
        yield { delta, done: false };
      }
    },
    async testConnection() {
      return { ok: true as const, model: "scripted" };
    },
    async listModels() {
      return { models: ["scripted"], source: "listing" as const };
    },
  };
  return { provider, calls, compressor };
}

async function setupStoryWithProvider(
  app: App,
  cookie: string,
): Promise<{ storyId: string; providerId: string }> {
  const created = await json(app, "POST", "/api/stories", { title: "Range Story" }, cookie);
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

async function seedActions(db: Parameters<typeof appendAction>[0], storyId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await appendAction(db, storyId, i % 2 === 0 ? "input" : "output", `seeded action ${i}`);
  }
}

async function insertRange(
  db: Parameters<typeof appendAction>[0],
  storyId: string,
  startIdx: number,
  endIdx: number,
  parentRangeId: string | null = null,
): Promise<string> {
  const id = `range-${crypto.randomUUID()}`;
  await db.insert(compressedRanges).values({
    id,
    storyId,
    startIdx,
    endIdx,
    summary: `summary ${startIdx}-${endIdx}`,
    parentRangeId,
    createdAt: Date.now(),
  });
  return id;
}

describe("ranges endpoints", () => {
  it("lists ranges ordered by startIdx with action counts", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 8);

    const child = await insertRange(db, storyId, 1, 2);
    const parent = await insertRange(db, storyId, 0, 4);
    await db.insert(compressedRanges).values({
      id: `range-${crypto.randomUUID()}`,
      storyId,
      startIdx: 1,
      endIdx: 2,
      summary: "child",
      parentRangeId: parent,
      createdAt: Date.now(),
    });
    void child;

    const res = await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie);
    expect(res.status).toBe(200);
    const { ranges } = (await res.json()) as {
      ranges: {
        id: string;
        startIdx: number;
        endIdx: number;
        summary: string;
        parentRangeId: string | null;
        createdAt: number;
        actionCount: number;
      }[];
    };
    expect(ranges).toHaveLength(3);
    expect(ranges.map((r) => r.startIdx)).toEqual([0, 1, 1]);
    const listed = ranges.find((r) => r.startIdx === 0);
    expect(listed).toMatchObject({
      startIdx: 0,
      endIdx: 4,
      summary: "summary 0-4",
      parentRangeId: null,
      actionCount: 5,
    });
    const nested = ranges.find((r) => r.summary === "child");
    expect(nested).toMatchObject({ parentRangeId: parent, actionCount: 2 });
  });

  it("returns [] for a story without ranges and 404s for unknown stories", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    const empty = await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ranges: [] });

    const missing = await json(app, "GET", "/api/stories/does-not-exist/ranges", undefined, cookie);
    expect(missing.status).toBe(404);

    const anon = await json(app, "GET", `/api/stories/${storyId}/ranges`);
    expect(anon.status).toBe(401);
  });

  it("deletes a range without touching actions; children re-surface", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 6);

    const parent = await insertRange(db, storyId, 0, 3);
    const child = await insertRange(db, storyId, 1, 2, parent);

    const del = await json(app, "DELETE", `/api/ranges/${parent}`, undefined, cookie);
    expect(del.status).toBe(200);

    // The child survives (no cascade) and re-surfaces as outermost.
    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie)
    ).json()) as { ranges: { id: string }[] };
    expect(listed.ranges.map((r) => r.id)).toEqual([child]);

    const actions = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: unknown[] };
    expect(actions.actions).toHaveLength(6);

    await json(app, "DELETE", `/api/ranges/${child}`, undefined, cookie);
    const gone = (await (
      await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie)
    ).json()) as { ranges: unknown[] };
    expect(gone.ranges).toEqual([]);
  });

  it("404s on unknown ranges and ranges from other owners", async () => {
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 4);

    const missing = await json(app, "DELETE", "/api/ranges/does-not-exist", undefined, cookie);
    expect(missing.status).toBe(404);

    // A range on a story the caller does not own reads as missing.
    const otherUserId = `user-${crypto.randomUUID()}`;
    const otherStoryId = `story-${crypto.randomUUID()}`;
    const now = Date.now();
    await db.insert(users).values({
      id: otherUserId,
      email: `${otherUserId}@example.com`,
      passwordHash: null,
      instanceAdmin: 0,
      createdAt: now,
    });
    await db.insert(stories).values({
      id: otherStoryId,
      userId: otherUserId,
      scenarioId: null,
      title: "Other",
      aiInstructions: "",
      plotEssentials: "",
      memory: "",
      summary: "",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const foreign = await insertRange(db, otherStoryId, 0, 1);
    const denied = await json(app, "DELETE", `/api/ranges/${foreign}`, undefined, cookie);
    expect(denied.status).toBe(404);

    const anon = await json(app, "DELETE", `/api/ranges/${foreign}`);
    expect(anon.status).toBe(401);
  });
});

describe("restoreRangeIds", () => {
  it("generate applies ranges by default and restores on request", async () => {
    const scripted = createScriptedProvider();
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => scripted.provider,
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 4);
    const rangeId = await insertRange(db, storyId, 0, 1);

    // Default: the range summary is injected, raw actions suppressed.
    const plain = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "look" },
      cookie,
    );
    expect(plain.status).toBe(200);
    const plainEvents = parseSse(await plain.text());
    const plainMeta = plainEvents[0].data as {
      rangesApplied: { id: string; startIdx: number; endIdx: number }[];
    };
    expect(plainMeta.rangesApplied).toEqual([{ id: rangeId, startIdx: 0, endIdx: 1 }]);
    const sent = scripted.calls[0].messages.map((m) => m.content).join("\n");
    expect(sent).toContain("[summary of idx 0–1]: summary 0-1");
    expect(sent).not.toContain("seeded action 0");

    // Restored: no ranges applied; the underlying actions go verbatim.
    const restored = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "look again", restoreRangeIds: [rangeId] },
      cookie,
    );
    expect(restored.status).toBe(200);
    const restoredEvents = parseSse(await restored.text());
    const restoredMeta = restoredEvents[0].data as { rangesApplied: unknown[] };
    expect(restoredMeta.rangesApplied).toEqual([]);
    const resent = scripted.calls[1].messages.map((m) => m.content).join("\n");
    expect(resent).toContain("seeded action 0");
    expect(resent).toContain("seeded action 1");
    expect(resent).not.toContain("[summary of idx");
  });

  it("rejects restore ids that do not belong to the story", async () => {
    const scripted = createScriptedProvider();
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => scripted.provider,
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 2);

    const unknown = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "hi", restoreRangeIds: ["range-nope"] },
      cookie,
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );

    // A range from a different story is equally invalid.
    const created = await json(app, "POST", "/api/stories", { title: "Second" }, cookie);
    const { story: second } = (await created.json()) as { story: { id: string } };
    const foreign = await insertRange(db, second.id, 0, 1);
    const cross = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "hi", restoreRangeIds: [foreign] },
      cookie,
    );
    expect(cross.status).toBe(400);
    expect(scripted.calls).toHaveLength(0);
  });

  it("retry honours an optional restore body and stays bodyless-compatible", async () => {
    const scripted = createScriptedProvider();
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => scripted.provider,
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);

    await json(app, "POST", `/api/stories/${storyId}/generate`, { input: "open" }, cookie).then(
      (res) => res.text(),
    );
    const rangeId = await insertRange(db, storyId, 0, 1);

    const retry = await json(
      app,
      "POST",
      `/api/stories/${storyId}/retry`,
      { restoreRangeIds: [rangeId] },
      cookie,
    );
    expect(retry.status).toBe(200);
    const events = parseSse(await retry.text());
    const meta = events[0].data as { rangesApplied: unknown[] };
    expect(meta.rangesApplied).toEqual([]);

    const bad = await json(
      app,
      "POST",
      `/api/stories/${storyId}/retry`,
      { restoreRangeIds: ["range-nope"] },
      cookie,
    );
    expect(bad.status).toBe(400);
  });
});

describe("compression trigger", () => {
  it("attempts nothing below the threshold", async () => {
    const scripted = createScriptedProvider();
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => scripted.provider,
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    await seedActions(db, storyId, 2);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "small turn" },
      cookie,
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events[events.length - 1].event).toBe("done");
    // Only the narrative call; no compressor call observed.
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0].maxTokens).not.toBe(600);

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie)
    ).json()) as { ranges: unknown[] };
    expect(listed.ranges).toEqual([]);
  });

  it("compresses above the threshold and inserts the decided range", async () => {
    const scripted = createScriptedProvider();
    scripted.compressor.text = JSON.stringify({
      shouldCompress: true,
      startIdx: 0,
      endIdx: 3,
      summary: "The traveler explored the foothills.",
    });
    const { app, db } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => scripted.provider,
    });
    const { cookie } = await setupAdmin(app);
    const { storyId } = await setupStoryWithProvider(app, cookie);
    // ~20k chars: past 60% of the 8192 budget at multiplier 1.
    for (let i = 0; i < 10; i++) {
      await appendAction(
        db,
        storyId,
        i % 2 === 0 ? "input" : "output",
        `long event ${i} ${"w".repeat(2000)}`,
      );
    }

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "continue on" },
      cookie,
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    // The visible turn is unaffected: meta/delta/done stream as usual.
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);

    // The mock observed the follow-up compressor call.
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[1].maxTokens).toBe(600);
    expect(scripted.calls[1].temperature).toBe(0.2);

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie)
    ).json()) as {
      ranges: { startIdx: number; endIdx: number; summary: string; actionCount: number }[];
    };
    expect(listed.ranges).toHaveLength(1);
    expect(listed.ranges[0]).toMatchObject({
      startIdx: 0,
      endIdx: 3,
      summary: "The traveler explored the foothills.",
      actionCount: 4,
    });

    // Never destructive: all 12 actions are still there.
    const actions = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: unknown[] };
    expect(actions.actions).toHaveLength(12);
  });

  it("leaves the turn untouched when the compressor declines or fails", async () => {
    for (const mode of ["decline", "throw"] as const) {
      const scripted = createScriptedProvider();
      if (mode === "throw") {
        scripted.compressor.error = new Error("compressor boom");
      }
      const { app, db } = createTestApp("single", {
        env: { allowPrivateProviderUrls: true },
        createProviderFn: () => scripted.provider,
      });
      const { cookie } = await setupAdmin(app);
      const { storyId } = await setupStoryWithProvider(app, cookie);
      for (let i = 0; i < 10; i++) {
        await appendAction(
          db,
          storyId,
          i % 2 === 0 ? "input" : "output",
          `long event ${i} ${"w".repeat(2000)}`,
        );
      }

      const res = await json(
        app,
        "POST",
        `/api/stories/${storyId}/generate`,
        { input: "go on" },
        cookie,
      );
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(events.map((e) => e.event)).toEqual(["meta", "delta", "delta", "done"]);

      const listed = (await (
        await json(app, "GET", `/api/stories/${storyId}/ranges`, undefined, cookie)
      ).json()) as { ranges: unknown[] };
      expect(listed.ranges).toEqual([]);

      const actions = (await (
        await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
      ).json()) as { actions: { type: string; text: string }[] };
      expect(actions.actions).toHaveLength(12);
      expect(actions.actions[10]).toMatchObject({ type: "input", text: "go on" });
    }
  });
});
