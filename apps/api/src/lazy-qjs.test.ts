import { describe, expect, it, vi } from "vitest";
import type { createApp } from "./app";
import { createTestApp, mockProviderFactory, setupAdmin } from "./testing";

// The QuickJS module is unavailable in this file: any code path that
// touches it fails the test. A generate on a scriptless story must
// succeed anyway, proving the module loads lazily on first script
// execution only. (Mocked at the qjs-module seam rather than the .wasm
// bytes: qjs-module falls back to compiling the vendored file under
// plain Node, so alias-level failure alone no longer proves laziness.)
vi.mock("./scripts/qjs-module.ts", () => ({
  getSandboxQuickJS: () => Promise.reject(new Error("WASM_MODULE_UNAVAILABLE")),
}));

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

describe("lazy QuickJS instantiation", () => {
  it("generates on a story with no scripts without touching WASM", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Scriptless" }, cookie);
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
    await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);

    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/generate`,
      { input: "hello" },
      cookie,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).not.toContain("WASM_MODULE_UNAVAILABLE");
  });

  it("fails a scripted turn when the module is unavailable (control)", async () => {
    // Control: with the WASM module mocked away, a turn that needs
    // scripts must fail — proving the mock above is active and the
    // passing test above is not vacuous.
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const created = await json(app, "POST", "/api/stories", { title: "Scripted" }, cookie);
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
    await json(app, "POST", `/api/providers/${prow.id}/default`, undefined, cookie);
    const script = await json(
      app,
      "POST",
      `/api/stories/${story.id}/scripts`,
      { name: "s", source: "text;" },
      cookie,
    );
    expect(script.status).toBe(201);

    const res = await json(
      app,
      "POST",
      `/api/stories/${story.id}/generate`,
      { input: "hello" },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: error");
  });
});
