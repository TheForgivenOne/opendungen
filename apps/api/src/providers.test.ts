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

const OLLAMA = {
  label: "local",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "llama3.2",
};

describe("providers", () => {
  it("requires auth in single mode", async () => {
    const { app } = createTestApp();
    for (const [method, path] of [
      ["GET", "/api/providers"],
      ["POST", "/api/providers"],
    ] as const) {
      const res = await json(app, method, path, method === "POST" ? OLLAMA : undefined);
      expect(res.status).toBe(401);
    }
  });

  it("creates, lists, patches, defaults, and deletes", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);

    const created = await json(app, "POST", "/api/providers", OLLAMA, cookie);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      provider: { id: string; hasKey: boolean; isDefault: boolean };
    };
    // Keyless local provider: no key stored, none leaked.
    expect(createdBody.provider.hasKey).toBe(false);
    expect(JSON.stringify(createdBody)).not.toContain("api_key_enc");
    const id = createdBody.provider.id;

    const keyed = await json(
      app,
      "POST",
      "/api/providers",
      { label: "cloud", kind: "openai", model: "gpt-4o-mini", apiKey: "sk-test-123" },
      cookie,
    );
    expect(keyed.status).toBe(201);
    const keyedBody = (await keyed.json()) as {
      provider: { id: string; hasKey: boolean; baseUrl: null };
    };
    expect(keyedBody.provider.hasKey).toBe(true);
    expect(keyedBody.provider.baseUrl).toBeNull();
    const keyedId = keyedBody.provider.id;

    const listed = await json(app, "GET", "/api/providers", undefined, cookie);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { providers: { id: string }[] };
    expect(listBody.providers).toHaveLength(2);
    expect(JSON.stringify(listBody)).not.toContain("api_key_enc");
    expect(JSON.stringify(listBody)).not.toContain("sk-test-123");

    const patched = await json(app, "PATCH", `/api/providers/${id}`, { label: "renamed" }, cookie);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { provider: { label: string } }).provider.label).toBe(
      "renamed",
    );

    const madeDefault = await json(app, "POST", `/api/providers/${id}/default`, undefined, cookie);
    expect(madeDefault.status).toBe(200);
    expect(
      ((await madeDefault.json()) as { provider: { isDefault: boolean } }).provider.isDefault,
    ).toBe(true);

    const relisted = (await (
      await json(app, "GET", "/api/providers", undefined, cookie)
    ).json()) as { providers: { id: string; isDefault: boolean }[] };
    expect(relisted.providers.find((p) => p.id === id)?.isDefault).toBe(true);
    expect(relisted.providers.find((p) => p.id === keyedId)?.isDefault).toBe(false);

    const tested = await json(app, "POST", `/api/providers/${id}/test`, undefined, cookie);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toEqual({ ok: true, model: "mock-model" });

    const deleted = await json(app, "DELETE", `/api/providers/${keyedId}`, undefined, cookie);
    expect(deleted.status).toBe(200);
    const after = (await (await json(app, "GET", "/api/providers", undefined, cookie)).json()) as {
      providers: unknown[];
    };
    expect(after.providers).toHaveLength(1);

    const missing = await json(app, "GET", "/api/providers", undefined, cookie);
    expect(missing.status).toBe(200);
    const gone = await json(app, "DELETE", `/api/providers/${keyedId}`, undefined, cookie);
    expect(gone.status).toBe(404);
  });

  it("omitted apiKey on PATCH leaves the stored key unchanged", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);
    const created = (await (
      await json(app, "POST", "/api/providers", { ...OLLAMA, apiKey: "ollama-key" }, cookie)
    ).json()) as { provider: { id: string; hasKey: boolean } };
    expect(created.provider.hasKey).toBe(true);

    const patched = (await (
      await json(app, "PATCH", `/api/providers/${created.provider.id}`, { label: "x" }, cookie)
    ).json()) as { provider: { hasKey: boolean } };
    expect(patched.provider.hasKey).toBe(true);

    const cleared = (await (
      await json(app, "PATCH", `/api/providers/${created.provider.id}`, { apiKey: "" }, cookie)
    ).json()) as { provider: { hasKey: boolean } };
    expect(cleared.provider.hasKey).toBe(false);
  });

  it("validates kind, model, and baseUrl rules", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);

    const badKind = await json(
      app,
      "POST",
      "/api/providers",
      { ...OLLAMA, kind: "mystery" },
      cookie,
    );
    expect(badKind.status).toBe(400);

    const noModel = await json(
      app,
      "POST",
      "/api/providers",
      { label: "x", kind: "openai" },
      cookie,
    );
    expect(noModel.status).toBe(400);

    const noBase = await json(
      app,
      "POST",
      "/api/providers",
      { label: "x", kind: "ollama", model: "m" },
      cookie,
    );
    expect(noBase.status).toBe(400);

    const compatNoBase = await json(
      app,
      "POST",
      "/api/providers",
      { label: "x", kind: "openai-compatible", model: "m" },
      cookie,
    );
    expect(compatNoBase.status).toBe(400);

    const badUrl = await json(
      app,
      "POST",
      "/api/providers",
      { ...OLLAMA, baseUrl: "not-a-url" },
      cookie,
    );
    expect(badUrl.status).toBe(400);

    const emptyPatch = await json(app, "PATCH", "/api/providers/nonexistent", {}, cookie);
    expect(emptyPatch.status).toBe(400);

    const missing = await json(app, "PATCH", "/api/providers/nonexistent", { label: "x" }, cookie);
    expect(missing.status).toBe(404);

    const missingTest = await json(
      app,
      "POST",
      "/api/providers/nonexistent/test",
      undefined,
      cookie,
    );
    expect(missingTest.status).toBe(404);

    const missingDefault = await json(
      app,
      "POST",
      "/api/providers/nonexistent/default",
      undefined,
      cookie,
    );
    expect(missingDefault.status).toBe(404);
  });
});

describe("provider label required", () => {
  it("rejects empty and whitespace-only labels on create and PATCH", async () => {
    const { app } = createTestApp("single", {
      env: { allowPrivateProviderUrls: true },
      createProviderFn: mockProviderFactory(),
    });
    const { cookie } = await setupAdmin(app);

    for (const label of ["", "   "]) {
      const res = await json(app, "POST", "/api/providers", { ...OLLAMA, label }, cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "provider_label_required",
      );
    }

    const created = await json(app, "POST", "/api/providers", OLLAMA, cookie);
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;

    for (const label of ["", "   "]) {
      const res = await json(app, "PATCH", `/api/providers/${id}`, { label }, cookie);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "provider_label_required",
      );
    }

    // A valid label still creates and patches fine.
    const renamed = await json(app, "PATCH", `/api/providers/${id}`, { label: "renamed" }, cookie);
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { provider: { label: string } }).provider.label).toBe(
      "renamed",
    );
  });
});
