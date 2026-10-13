import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { createMockProvider, createTestApp, mockProviderFactory, setupAdmin } from "./testing";
import type { LLMChunk, LLMProvider, LLMRequest, ProviderConfigInput } from "./llm";

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

interface SeenCall {
  config: ProviderConfigInput;
  req: LLMRequest;
}

// Mock factory that records every provider config built and every
// complete() request (narrative and compressor alike).
function recordingFactory(seen: SeenCall[], chunks: string[] = ["Hello"]) {
  return (config: ProviderConfigInput): LLMProvider => {
    const inner = createMockProvider({ chunks });
    return {
      ...inner,
      async *complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
        seen.push({ config: { ...config }, req });
        yield* inner.complete(req, signal);
      },
    };
  };
}

async function makeProvider(app: App, cookie: string, label: string, model: string) {
  const res = await json(
    app,
    "POST",
    "/api/providers",
    { label, kind: "ollama", baseUrl: "http://127.0.0.1:11434", model },
    cookie,
  );
  expect(res.status).toBe(201);
  const { provider } = (await res.json()) as { provider: { id: string } };
  return provider.id;
}

async function makeStory(app: App, cookie: string, title: string) {
  const res = await json(app, "POST", "/api/stories", { title }, cookie);
  expect(res.status).toBe(201);
  const { story } = (await res.json()) as { story: { id: string } };
  return story.id;
}

async function generate(app: App, cookie: string, storyId: string, input: string) {
  const res = await json(app, "POST", `/api/stories/${storyId}/generate`, { input }, cookie);
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

describe("per-story provider override", () => {
  it("uses the override when set, the default otherwise", async () => {
    const seen: SeenCall[] = [];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    const b = await makeProvider(app, cookie, "B", "model-b");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);
    const storyId = await makeStory(app, cookie, "Override Me");

    await generate(app, cookie, storyId, "first");
    expect(seen.at(-1)?.config.model).toBe("model-a");

    const patched = await json(app, "PATCH", `/api/stories/${storyId}`, { providerId: b }, cookie);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { story: { providerId: string } }).story.providerId).toBe(b);

    await generate(app, cookie, storyId, "second");
    expect(seen.at(-1)?.config.model).toBe("model-b");

    // One-off body override wins over the persistent one.
    const oneOff = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "third", providerId: a },
      cookie,
    );
    expect(oneOff.status).toBe(200);
    await oneOff.text();
    expect(seen.at(-1)?.config.model).toBe("model-a");
  });

  it("reverts to the default when the override provider is deleted", async () => {
    const seen: SeenCall[] = [];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    const b = await makeProvider(app, cookie, "B", "model-b");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);
    const storyId = await makeStory(app, cookie, "Revert Me");
    await json(app, "PATCH", `/api/stories/${storyId}`, { providerId: b }, cookie);

    const deleted = await json(app, "DELETE", `/api/providers/${b}`, undefined, cookie);
    expect(deleted.status).toBe(200);
    const fetched = await json(app, "GET", `/api/stories/${storyId}`, undefined, cookie);
    expect(
      ((await fetched.json()) as { story: { providerId: string | null } }).story.providerId,
    ).toBe(null);
    await generate(app, cookie, storyId, "after delete");
    expect(seen.at(-1)?.config.model).toBe("model-a");
  });

  it("rejects unknown override ids and clears on null", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const storyId = await makeStory(app, cookie, "Patch Me");

    const bad = await json(app, "PATCH", `/api/stories/${storyId}`, { providerId: "nope" }, cookie);
    expect(bad.status).toBe(404);

    const cleared = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}`,
      { providerId: null },
      cookie,
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { story: { providerId: string | null } }).story.providerId,
    ).toBe(null);
  });

  it("retry uses the override, or the current default when none", async () => {
    const seen: SeenCall[] = [];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    const b = await makeProvider(app, cookie, "B", "model-b");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);

    // Story with an override retries on the override.
    const storyId = await makeStory(app, cookie, "Retry Override");
    await json(app, "PATCH", `/api/stories/${storyId}`, { providerId: b }, cookie);
    await generate(app, cookie, storyId, "go");
    const retry = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(retry.status).toBe(200);
    await retry.text();
    expect(seen.map((s) => s.config.model)).toEqual(["model-b", "model-b"]);

    // Story without an override retries on the CURRENT default, even
    // when it changed since generation.
    seen.length = 0;
    const story2 = await makeStory(app, cookie, "Retry Default");
    await generate(app, cookie, story2, "go");
    await json(app, "POST", `/api/providers/${b}/default`, undefined, cookie);
    const retry2 = await json(app, "POST", `/api/stories/${story2}/retry`, undefined, cookie);
    expect(retry2.status).toBe(200);
    await retry2.text();
    expect(seen.map((s) => s.config.model)).toEqual(["model-a", "model-b"]);
  });

  it("retry accepts a one-off providerId body", async () => {
    const seen: SeenCall[] = [];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    const b = await makeProvider(app, cookie, "B", "model-b");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);
    const storyId = await makeStory(app, cookie, "Retry One-Off");
    await json(app, "PATCH", `/api/stories/${storyId}`, { providerId: b }, cookie);
    await generate(app, cookie, storyId, "go");
    const retry = await json(
      app,
      "POST",
      `/api/stories/${storyId}/retry`,
      { providerId: a },
      cookie,
    );
    expect(retry.status).toBe(200);
    await retry.text();
    expect(seen.map((s) => s.config.model)).toEqual(["model-b", "model-a"]);
  });
});

describe("per-story context/compressor overrides", () => {
  it("applies max_output_tokens and context_tokens when set", async () => {
    const seen: SeenCall[] = [];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);
    const bigMemory = "m".repeat(8000);

    const plain = await makeStory(app, cookie, "Plain");
    await json(app, "PATCH", `/api/stories/${plain}`, { memory: bigMemory }, cookie);
    const plainEvents = await generate(app, cookie, plain, "go");
    const plainMeta = plainEvents.find((e) => e.event === "meta");
    expect(plainMeta).toBeDefined();
    // Memory is capped to its 25% dynamic share first: 2458 * 25% =
    // 614t, plus the fixed layers (base + constraints + mode ≈ 252t).
    const plainRequired = (plainMeta?.data as { usage: { required: number } }).usage.required;
    expect(plainRequired).toBe(866);
    const narrativeReq = (calls: SeenCall[]) =>
      calls.find((call) => !(call.req.messages[0]?.content ?? "").includes("compression engine"))
        ?.req;
    expect(narrativeReq(seen)?.maxTokens).toBe(400);

    const tuned = await makeStory(app, cookie, "Tuned");
    const patched = await json(
      app,
      "PATCH",
      `/api/stories/${tuned}`,
      { memory: bigMemory, contextTokens: 2048, maxOutputTokens: 111 },
      cookie,
    );
    expect(patched.status).toBe(200);
    expect(
      ((await patched.json()) as { story: { contextTokens: number } }).story.contextTokens,
    ).toBe(2048);
    const mark = seen.length;
    const tunedEvents = await generate(app, cookie, tuned, "go");
    const tunedMeta = tunedEvents.find((e) => e.event === "meta");
    const tunedRequired = (tunedMeta?.data as { usage: { required: number } }).usage.required;
    // contextTokens=2048 shrinks every share: memory's 25% of the 615
    // dynamic tokens (153t) trims far below the default-budget value.
    expect(tunedRequired).toBe(plainRequired - 614 + 153);
    expect(tunedRequired).toBeLessThan(plainRequired);
    // The tuned turn's narrative request (not its compressor tail).
    expect(narrativeReq(seen.slice(mark))?.maxTokens).toBe(111);
  });

  it("applies the compressor trigger and params when set", async () => {
    const seen: SeenCall[] = [];
    const compressorChunks = ['{"shouldCompress": false}'];
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: recordingFactory(seen, compressorChunks),
    });
    const { cookie } = await setupAdmin(app);
    const a = await makeProvider(app, cookie, "A", "model-a");
    await json(app, "POST", `/api/providers/${a}/default`, undefined, cookie);
    // ~2500 tokens of log: below the default 60% trigger (4915) but
    // above a 30% override trigger (2458).
    const filler = "f".repeat(5000);
    async function seedLog(title: string) {
      const storyId = await makeStory(app, cookie, title);
      for (let i = 0; i < 2; i++) {
        const res = await json(
          app,
          "POST",
          `/api/stories/${storyId}/actions`,
          { type: "input", text: `${filler}${i}` },
          cookie,
        );
        expect(res.status).toBe(201);
      }
      return storyId;
    }
    const isCompressorCall = (call: SeenCall) =>
      (call.req.messages[0]?.content ?? "").includes("compression engine");

    const plain = await seedLog("Plain Trigger");
    seen.length = 0;
    await generate(app, cookie, plain, "go");
    expect(seen.some(isCompressorCall)).toBe(false);

    const tuned = await seedLog("Tuned Trigger");
    const patched = await json(
      app,
      "PATCH",
      `/api/stories/${tuned}`,
      { compressTriggerPct: 0.3, compressMaxTokens: 250, compressTemperature: 0.5 },
      cookie,
    );
    expect(patched.status).toBe(200);
    seen.length = 0;
    await generate(app, cookie, tuned, "go");
    const compressorCalls = seen.filter(isCompressorCall);
    expect(compressorCalls).toHaveLength(1);
    expect(compressorCalls[0].req.maxTokens).toBe(250);
    expect(compressorCalls[0].req.temperature).toBe(0.5);
  });

  it("rejects out-of-range override values", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const storyId = await makeStory(app, cookie, "Validated");
    const cases: [string, unknown][] = [
      ["contextTokens", 1000],
      ["contextTokens", 300000],
      ["contextTokens", 2048.5],
      ["maxOutputTokens", 50],
      ["maxOutputTokens", 5000],
      ["compressTriggerPct", 0.2],
      ["compressTriggerPct", 0.99],
      ["compressMaxTokens", 100],
      ["compressMaxTokens", 3000],
      ["compressTemperature", -0.5],
      ["compressTemperature", 1.5],
      ["contextTokens", "lots"],
    ];
    for (const [field, value] of cases) {
      const res = await json(app, "PATCH", `/api/stories/${storyId}`, { [field]: value }, cookie);
      expect(res.status).toBe(400);
    }
    // Boundary values are accepted, and null resets to defaults.
    const ok = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}`,
      {
        contextTokens: 2048,
        maxOutputTokens: 100,
        compressTriggerPct: 0.3,
        compressMaxTokens: 200,
        compressTemperature: 0,
      },
      cookie,
    );
    expect(ok.status).toBe(200);
    const reset = await json(
      app,
      "PATCH",
      `/api/stories/${storyId}`,
      {
        contextTokens: null,
        maxOutputTokens: null,
        compressTriggerPct: null,
        compressMaxTokens: null,
        compressTemperature: null,
      },
      cookie,
    );
    expect(reset.status).toBe(200);
    const story = (
      (await reset.json()) as {
        story: { contextTokens: number | null; maxOutputTokens: number | null };
      }
    ).story;
    expect(story.contextTokens).toBe(null);
    expect(story.maxOutputTokens).toBe(null);
  });
});
