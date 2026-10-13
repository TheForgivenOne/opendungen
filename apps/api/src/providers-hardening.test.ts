// Provider listing endpoint (shape/cache/invalidation/SSRF),
// custom-headers validation + masking, timeout validation, and
// end-to-end flows (429 retry, custom-header send, TTFT timeout +
// retry, real usage on done).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "./app";
import { encryptSecret } from "./crypto";
import { providerConfigs } from "./db/schema";
import { createTestApp, setupAdmin, TEST_SECRET } from "./testing";

type App = ReturnType<typeof createApp>;

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function sseResponse(payloads: (string | object)[]): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}`)
    .join("\n\n");
  return new Response(`${body}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// A stream that never produces bytes but fails promptly when the
// request signal aborts (mirrors undici's abort semantics for the
// pipeline's timeout tests).
function stalledResponse(signal: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const COMPAT = {
  label: "stub",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:8080",
  model: "stub-model",
};

async function setupStory(app: App, cookie: string): Promise<string> {
  const created = await json(app, "POST", "/api/stories", { title: "P7" }, cookie);
  expect(created.status).toBe(201);
  return ((await created.json()) as { story: { id: string } }).story.id;
}

async function createCompatProvider(
  app: App,
  cookie: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = await json(app, "POST", "/api/providers", { ...COMPAT, ...extra }, cookie);
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { provider: { id: string } }).provider.id;
  const def = await json(app, "POST", `/api/providers/${id}/default`, undefined, cookie);
  expect(def.status).toBe(200);
  return id;
}

describe("GET /api/providers/:id/models", () => {
  it("returns the listing and caches per provider id for 5 minutes", async () => {
    let listings = 0;
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => ({
        kind: "ollama" as const,
        supportsCaching: false,
        supportsMultipleSystemMessages: false,
        tokenMultiplier: 1.0,
        async *complete() {
          yield { delta: "x", done: false as const };
        },
        async testConnection() {
          return { ok: true as const, model: "m" };
        },
        async listModels() {
          listings++;
          return { models: ["b", "a"], source: "listing" as const };
        },
      }),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/providers",
      { label: "l", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "a" },
      cookie,
    );
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;

    const first = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ models: ["b", "a"], source: "listing" });

    const second = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(await second.json()).toEqual({ models: ["b", "a"], source: "listing" });
    // The second GET served the cached entry: one listing call total.
    expect(listings).toBe(1);

    // PATCH invalidates the cache: the next GET lists again.
    const patched = await json(app, "PATCH", `/api/providers/${id}`, { label: "l2" }, cookie);
    expect(patched.status).toBe(200);
    const third = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(third.status).toBe(200);
    expect(listings).toBe(2);
  });

  it("reports the fallback source when the backend has no listing", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => ({
        kind: "ollama" as const,
        supportsCaching: false,
        supportsMultipleSystemMessages: false,
        tokenMultiplier: 1.0,
        async *complete() {
          yield { delta: "x", done: false as const };
        },
        async testConnection() {
          return { ok: true as const, model: "m" };
        },
        async listModels() {
          return { models: [], source: "fallback" as const };
        },
      }),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/providers", COMPAT, cookie);
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;
    const res = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [], source: "fallback" });
  });

  it("404s for unknown providers and SSRF-gates private baseUrls", async () => {
    const { app, db } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const missing = await json(app, "GET", "/api/providers/nope/models", undefined, cookie);
    expect(missing.status).toBe(404);

    // A row with a non-default private baseUrl (inserted directly to
    // bypass the create-time gate) is rejected by the models route.
    // The two literal local-Ollama defaults bypass this gate.
    const userId = (
      (await json(app, "GET", "/api/auth/me", undefined, cookie).then((r) => r.json())) as {
        user: { id: string };
      }
    ).user.id;
    await db.insert(providerConfigs).values({
      id: "prov-private",
      userId,
      label: "private",
      kind: "ollama",
      baseUrl: "http://10.0.0.5:11434",
      model: "m",
      apiKeyEnc: await encryptSecret(TEST_SECRET, ""),
      isDefault: 0,
      createdAt: Date.now(),
      ttftTimeoutMs: null,
      totalTimeoutMs: null,
      customHeaders: null,
    });
    const blocked = await json(app, "GET", "/api/providers/prov-private/models", undefined, cookie);
    expect(blocked.status).toBe(400);
  });
});

describe("custom headers", () => {
  it("rejects reserved names, non-objects, and oversized values", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);

    for (const customHeaders of [
      { Host: "evil" },
      { authorization: "x" },
      { "X-Api-Key": "x" },
      { Cookie: "x" },
      { "bad name!": "x" },
      { "X-Big": "y".repeat(4097) },
      "not-an-object",
    ]) {
      const res = await json(app, "POST", "/api/providers", { ...COMPAT, customHeaders }, cookie);
      expect(res.status).toBe(400);
    }
    // An 8 KB+ total also fails.
    const huge: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      huge[`X-H-${i}`] = "z".repeat(1000);
    }
    const big = await json(
      app,
      "POST",
      "/api/providers",
      { ...COMPAT, customHeaders: huge },
      cookie,
    );
    expect(big.status).toBe(400);
  });

  it("stores valid headers, masks them on GET, and clears on null", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/providers",
      { ...COMPAT, customHeaders: { "X-Test": "abc" } },
      cookie,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { provider: Record<string, unknown> };
    expect(body.provider.hasCustomHeaders).toBe(true);
    expect(JSON.stringify(body)).not.toContain("abc");

    const listed = (await (await json(app, "GET", "/api/providers", undefined, cookie)).json()) as {
      providers: Record<string, unknown>[];
    };
    expect(listed.providers[0]?.hasCustomHeaders).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("abc");

    const cleared = await json(
      app,
      "PATCH",
      `/api/providers/${body.provider.id}`,
      { customHeaders: null },
      cookie,
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { provider: { hasCustomHeaders: boolean } }).provider
        .hasCustomHeaders,
    ).toBe(false);
  });

  it("non-openai-compatible kinds accept the field but never send it", async () => {
    const seenHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        seenHeaders.push({ ...((init?.headers as Record<string, string>) ?? {}) });
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    // Stored (validated) but ignored by the OpenAI adapter's listing.
    const created = await json(
      app,
      "POST",
      "/api/providers",
      {
        label: "o",
        kind: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-x",
        customHeaders: { "X-Test": "abc" },
      },
      cookie,
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;
    const listed = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(listed.status).toBe(200);
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]).not.toHaveProperty("X-Test");
  });
});

describe("provider timeouts", () => {
  it("validates ranges on create and PATCH and reads back", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);

    const tooSmall = await json(
      app,
      "POST",
      "/api/providers",
      { ...COMPAT, ttftTimeoutMs: 500 },
      cookie,
    );
    expect(tooSmall.status).toBe(400);
    const tooBig = await json(
      app,
      "POST",
      "/api/providers",
      { ...COMPAT, totalTimeoutMs: 700000 },
      cookie,
    );
    expect(tooBig.status).toBe(400);

    const created = await json(
      app,
      "POST",
      "/api/providers",
      { ...COMPAT, ttftTimeoutMs: 2000, totalTimeoutMs: 90000 },
      cookie,
    );
    expect(created.status).toBe(201);
    const provider = (
      (await created.json()) as {
        provider: { id: string; ttftTimeoutMs: number; totalTimeoutMs: number };
      }
    ).provider;
    expect(provider.ttftTimeoutMs).toBe(2000);
    expect(provider.totalTimeoutMs).toBe(90000);

    const badPatch = await json(
      app,
      "PATCH",
      `/api/providers/${provider.id}`,
      { ttftTimeoutMs: 999 },
      cookie,
    );
    expect(badPatch.status).toBe(400);

    const cleared = await json(
      app,
      "PATCH",
      `/api/providers/${provider.id}`,
      { ttftTimeoutMs: null },
      cookie,
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { provider: { ttftTimeoutMs: null } }).provider.ttftTimeoutMs,
    ).toBeNull();
  });
});

describe("hardened flows end to end (real adapter, stubbed fetch)", () => {
  it("a 429 on first call retries once and succeeds", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return new Response("limited", { status: 429 });
        }
        return sseResponse([{ choices: [{ delta: { content: "after retry" } }] }, "[DONE]"]);
      }),
    );
    // No createProviderFn: the real openai-compatible adapter runs.
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    await createCompatProvider(app, cookie);
    const storyId = await setupStory(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "go" },
      cookie,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("after retry");
    expect(calls.filter((u) => u.endsWith("/v1/chat/completions"))).toHaveLength(2);
  });

  it("custom headers ride on the generation request", async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sentHeaders = { ...((init?.headers as Record<string, string>) ?? {}) };
        return sseResponse([{ choices: [{ delta: { content: "hi" } }] }, "[DONE]"]);
      }),
    );
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    await createCompatProvider(app, cookie, { customHeaders: { "X-Test": "abc" } });
    const storyId = await setupStory(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "go" },
      cookie,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(sentHeaders["X-Test"]).toBe("abc");
    expect(sentHeaders.authorization).toBeUndefined();
  });

  it("TTFT timeout persists the input, and retry regenerates without deletion", async () => {
    let mode: "stall" | "ok" = "stall";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (mode === "stall") {
          return stalledResponse((init?.signal as AbortSignal | undefined) ?? null);
        }
        return sseResponse([{ choices: [{ delta: { content: "recovered" } }] }, "[DONE]"]);
      }),
    );
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    await createCompatProvider(app, cookie, { ttftTimeoutMs: 1000 });
    const storyId = await setupStory(app, cookie);

    const timed = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "hello?" },
      cookie,
    );
    expect(timed.status).toBe(200);
    const events = timed.headers.get("content-type") ?? "";
    expect(events).toContain("text/event-stream");
    const text = await timed.text();
    expect(text).toContain("timeout_ttft");

    const listed = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { id: string; idx: number; type: string; text: string }[] };
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0]).toMatchObject({ idx: 0, type: "input", text: "hello?" });
    const inputId = listed.actions[0]?.id;

    // Retry the lone input: no deletion, output generated for it.
    mode = "ok";
    const retry = await json(app, "POST", `/api/stories/${storyId}/retry`, undefined, cookie);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("recovered");
    const after = (await (
      await json(app, "GET", `/api/stories/${storyId}/actions`, undefined, cookie)
    ).json()) as { actions: { id: string; idx: number; type: string; text: string }[] };
    expect(after.actions).toHaveLength(2);
    expect(after.actions[0]?.id).toBe(inputId);
    expect(after.actions[1]).toMatchObject({ idx: 1, type: "output", text: "recovered" });
  });

  it("real provider usage lands on the done event with source provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "hi" } }] },
          { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
          "[DONE]",
        ]),
      ),
    );
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    await createCompatProvider(app, cookie);
    const storyId = await setupStory(app, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/generate`,
      { input: "go" },
      cookie,
    );
    const blocks = (await res.text())
      .split("\n\n")
      .map((b) => b.trim())
      .filter(Boolean);
    const doneBlock = blocks.find((b) => b.startsWith("event: done"));
    expect(doneBlock).toBeTruthy();
    const dataLine = doneBlock?.split("\n").find((l) => l.startsWith("data:")) ?? "";
    const data = JSON.parse(dataLine.slice("data:".length).trim()) as {
      usage: { inputTokens: number; outputTokens: number; source: string };
    };
    expect(data.usage).toEqual({ inputTokens: 42, outputTokens: 7, source: "provider" });
  });
});

describe("ollama cloud providers", () => {
  const CLOUD = {
    label: "cloud",
    kind: "ollama",
    baseUrl: "https://ollama.com",
    model: "qwen3:8b",
  };

  it("requires an API key for Ollama Cloud on create", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await json(app, "POST", "/api/providers", CLOUD, cookie);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "ollama_cloud_key_required",
    );
  });

  it("creates an Ollama Cloud provider with a key", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const res = await json(
      app,
      "POST",
      "/api/providers",
      { ...CLOUD, apiKey: "fake-cloud-key" },
      cookie,
    );
    expect(res.status).toBe(201);
  });

  it("rejects pointing an ollama row at the cloud without a key on PATCH", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/providers",
      { label: "l", kind: "ollama", baseUrl: "http://localhost:11434", model: "m" },
      cookie,
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;
    const patched = await json(
      app,
      "PATCH",
      `/api/providers/${id}`,
      { baseUrl: "https://ollama.com" },
      cookie,
    );
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { error: { code: string } }).error.code).toBe(
      "ollama_cloud_key_required",
    );
  });

  it("allows the localhost defaults without the SSRF flag", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    for (const baseUrl of ["http://localhost:11434", "http://127.0.0.1:11434"]) {
      const res = await json(
        app,
        "POST",
        "/api/providers",
        { label: "local", kind: "ollama", baseUrl, model: "m" },
        cookie,
      );
      expect(res.status).toBe(201);
    }
  });

  it("still rejects other private IPs without the flag, and allows them with it", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const blocked = await json(
      app,
      "POST",
      "/api/providers",
      { label: "lan", kind: "ollama", baseUrl: "http://10.0.0.5:11434", model: "m" },
      cookie,
    );
    expect(blocked.status).toBe(400);

    const permissive = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const admin = await setupAdmin(permissive.app);
    const allowed = await json(
      permissive.app,
      "POST",
      "/api/providers",
      { label: "lan", kind: "ollama", baseUrl: "http://10.0.0.5:11434", model: "m" },
      admin.cookie,
    );
    expect(allowed.status).toBe(201);
  });

  it("sends the Bearer header to the cloud listing endpoint", async () => {
    const seenHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://ollama.com/api/tags");
        seenHeaders.push({ ...((init?.headers as Record<string, string>) ?? {}) });
        return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    // Real adapter factory: the stub stands in for ollama.com.
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const created = await json(
      app,
      "POST",
      "/api/providers",
      { ...CLOUD, apiKey: "fake-cloud-key" },
      cookie,
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;
    const listed = await json(app, "GET", `/api/providers/${id}/models`, undefined, cookie);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ models: ["qwen3:8b"], source: "listing" });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.authorization).toBe("Bearer fake-cloud-key");
  });
});
