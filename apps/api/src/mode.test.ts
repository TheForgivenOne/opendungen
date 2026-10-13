// Input modes: client-side text transformation (the server
// applies the same idempotent rule) + persistence + rendering shapes.

import { describe, expect, it } from "vitest";
import { applyInputMode } from "./input-mode";
import { createTestApp, mockProviderFactory, setupAdmin } from "./testing";
import type { createApp } from "./app";

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

describe("applyInputMode", () => {
  it("prefixes do inputs with 'You '", () => {
    expect(applyInputMode("open the door", "do")).toBe("You open the door");
  });
  it("leaves do inputs starting with 'You ' alone", () => {
    expect(applyInputMode("You open the door", "do")).toBe("You open the door");
  });
  it("matches the You/I prefixes case-insensitively", () => {
    expect(applyInputMode("you run", "do")).toBe("you run");
    expect(applyInputMode("I draw my sword", "do")).toBe("I draw my sword");
    expect(applyInputMode("i draw my sword", "do")).toBe("i draw my sword");
  });
  it("wraps say inputs in double quotes", () => {
    expect(applyInputMode("hello there", "say")).toBe('"hello there"');
  });
  it("leaves already-quoted say inputs alone", () => {
    expect(applyInputMode('"hello there"', "say")).toBe('"hello there"');
  });
  it("passes story inputs through unchanged", () => {
    expect(applyInputMode("The dragon wakes.", "story")).toBe("The dragon wakes.");
  });
});

describe("mode persistence", () => {
  async function setup(): Promise<{ app: App; cookie: string; storyId: string }> {
    const { app } = createTestApp("single");
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Modes" }, cookie);
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as { story: { id: string } };
    return { app, cookie, storyId: story.id };
  }

  it("stores transformed text + mode on POST action with mode=do", async () => {
    const { app, cookie, storyId } = await setup();
    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/actions`,
      { type: "input", text: "open the door", mode: "do" },
      cookie,
    );
    expect(res.status).toBe(201);
    const { action } = (await res.json()) as {
      action: { text: string; mode: string | null };
    };
    expect(action.text).toBe("You open the door");
    expect(action.mode).toBe("do");
  });

  it("stores quoted text + mode on POST action with mode=say", async () => {
    const { app, cookie, storyId } = await setup();
    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/actions`,
      { type: "input", text: "hello there", mode: "say" },
      cookie,
    );
    expect(res.status).toBe(201);
    const { action } = (await res.json()) as {
      action: { text: string; mode: string | null };
    };
    expect(action.text).toBe('"hello there"');
    expect(action.mode).toBe("say");
  });

  it("leaves text unchanged and defaults mode to story when omitted", async () => {
    const { app, cookie, storyId } = await setup();
    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/actions`,
      { type: "input", text: "The dragon wakes." },
      cookie,
    );
    expect(res.status).toBe(201);
    const { action } = (await res.json()) as {
      action: { text: string; mode: string | null };
    };
    expect(action.text).toBe("The dragon wakes.");
    expect(action.mode).toBe("story");
  });

  it("rejects an unknown mode", async () => {
    const { app, cookie, storyId } = await setup();
    const res = await json(
      app,
      "POST",
      `/api/stories/${storyId}/actions`,
      { type: "input", text: "x", mode: "shout" },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  it("generate persists the transformed input with its mode", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Modes" }, cookie);
    expect(created.status).toBe(201);
    const { story } = (await created.json()) as { story: { id: string } };
    const provider = await json(
      app,
      "POST",
      "/api/providers",
      { label: "mock", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "mock" },
      cookie,
    );
    expect(provider.status).toBe(201);
    const { provider: prow } = (await provider.json()) as { provider: { id: string } };
    const def = await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);
    expect(def.status).toBe(200);

    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/generate`,
      { input: "open the door", mode: "do" },
      cookie,
    );
    expect(res.status).toBe(200);
    // Consume the whole SSE body first: app.request resolves on
    // response headers, and the output row only exists once the
    // stream (ending in `done`) has been fully produced.
    const sse = await res.text();
    expect(sse).toContain("event: done");
    const listed = await json(app, "GET", `/api/stories/${story.id}/actions`, undefined, cookie);
    expect(listed.status).toBe(200);
    const { actions } = (await listed.json()) as {
      actions: { type: string; text: string; mode: string | null }[];
    };
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "input", text: "You open the door", mode: "do" });
    expect(actions[1]).toMatchObject({ type: "output", mode: null });
  });
});
