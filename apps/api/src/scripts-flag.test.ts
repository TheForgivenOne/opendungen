import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "./app";
import { mockProviderFactory } from "./testing";
import { createTestApp, setupAdmin } from "./testing";

type App = ReturnType<typeof createApp>;

afterEach(() => {
  vi.restoreAllMocks();
});

async function scriptedStory(app: App, cookie: string): Promise<{ storyId: string; sse: string }> {
  // A default provider row (the mock factory builds the live object;
  // kind openai needs no baseUrl, so no SSRF check fires).
  const provider = await app.request("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ label: "Mock", kind: "openai", model: "m" }),
  });
  expect(provider.status).toBe(201);
  const { provider: row } = (await provider.json()) as { provider: { id: string } };
  await app.request(`/api/providers/${row.id}/default`, { method: "POST", headers: { cookie } });
  const created = await app.request("/api/stories", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Flag Story" }),
  });
  expect(created.status).toBe(201);
  const { story } = (await created.json()) as { story: { id: string } };
  const script = await app.request(`/api/stories/${story.id}/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "loud", source: 'throw new Error("must not run");' }),
  });
  expect(script.status).toBe(201);
  const gen = await app.request(`/api/stories/${story.id}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ input: "You shout." }),
  });
  expect(gen.status).toBe(200);
  return { storyId: story.id, sse: await gen.text() };
}

describe("INSTANCE_SCRIPTS_ENABLED=false", () => {
  it("skips scripts, still generates, and warns once per boot", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app } = createTestApp("single", {
      env: { scriptsEnabled: false },
      createProviderFn: mockProviderFactory({ chunks: ["Fine."] }),
    });
    const { cookie } = await setupAdmin(app);

    const first = await scriptedStory(app, cookie);
    expect(first.sse).toContain("event: done");
    expect(first.sse).not.toContain("script_errors");
    expect(first.sse).not.toContain("must not run");
    // A second turn proves the warning is logged once, not per turn.
    await scriptedStory(app, cookie);

    const warnings = spy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as { level: string; msg: string };
        } catch {
          return null;
        }
      })
      .filter((line) => line?.level === "warn" && line.msg.includes("scripts are disabled"));
    expect(warnings.length).toBe(1);
  });

  it("refuses script validation while disabled", async () => {
    const { app } = createTestApp("single", { env: { scriptsEnabled: false } });
    const { cookie } = await setupAdmin(app);
    const res = await app.request("/api/scripts/validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ source: "text;" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "scripts are disabled on this instance" });
  });
});
