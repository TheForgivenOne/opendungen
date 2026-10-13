// SSE keepalive: while a turn stalls, the client receives comment
// lines every 15 seconds, before any delta.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "./app";
import { createTestApp, setupAdmin } from "./testing";
import type { LLMChunk } from "./llm";

type App = ReturnType<typeof createApp>;

afterEach(() => {
  vi.useRealTimers();
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

describe("SSE keepalive", () => {
  it("emits comment lines while the provider stalls", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: () => ({
        kind: "ollama" as const,
        supportsCaching: false,
        supportsMultipleSystemMessages: false,
        tokenMultiplier: 1.0,
        async *complete(): AsyncIterable<LLMChunk> {
          await gate;
          yield { delta: "finally", done: false };
        },
        async testConnection() {
          return { ok: true as const, model: "mock-model" };
        },
        async listModels() {
          return { models: ["mock-model"], source: "listing" as const };
        },
      }),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Stall" }, cookie);
    const { story } = (await created.json()) as { story: { id: string } };
    const provider = await json(
      app,
      "POST",
      "/api/providers",
      { label: "m", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "mock-model" },
      cookie,
    );
    const { provider: prow } = (await provider.json()) as { provider: { id: string } };
    await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/generate`,
      { input: "wait for it" },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();

    // Stall 40 virtual seconds: keepalive fires at 15s and 30s while
    // the provider emits nothing.
    await vi.advanceTimersByTimeAsync(40000);
    release();
    // Let the turn finish and the stream close.
    await vi.advanceTimersByTimeAsync(5000);

    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    const keepalives = text.split(": keepalive").length - 1;
    expect(keepalives).toBeGreaterThanOrEqual(2);
    // Both keepalives precede the first delta.
    const firstDelta = text.indexOf("event: delta");
    expect(firstDelta).toBeGreaterThan(0);
    expect(text.lastIndexOf(": keepalive", firstDelta)).toBeGreaterThanOrEqual(0);
    expect(text).toContain("finally");
  });
});
