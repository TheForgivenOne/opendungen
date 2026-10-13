// Model listing per adapter: endpoint URLs, response shapes,
// dedupe/sort/cap, the openai-compatible 404/405 fallback, and
// testConnection's listing-first strategy with its minimal-completion
// fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic-provider";
import { normalizeModelList, pickTestModel } from "./listing";
import { OllamaProvider, isOllamaCloud } from "./ollama-provider";
import {
  OpenAICompatibleProvider,
  __clearStreamOptionsCacheForTests,
} from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";

afterEach(() => {
  vi.unstubAllGlobals();
  __clearStreamOptionsCacheForTests();
});

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (seen: SeenRequest) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = { url: String(url), init };
      seen.push(request);
      return handler(request);
    }),
  );
  return seen;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeModelList / pickTestModel", () => {
  it("dedupes, sorts, drops non-strings, and caps at 500", () => {
    expect(normalizeModelList(["b", "a", "b", 42, "", null])).toEqual(["a", "b"]);
    const many = Array.from({ length: 600 }, (_, i) => `m-${String(i).padStart(3, "0")}`);
    expect(normalizeModelList(many)).toHaveLength(500);
  });

  it("picks the configured model, else the first, else the configured string", () => {
    expect(pickTestModel("m", ["a", "m"])).toBe("m");
    expect(pickTestModel("missing", ["b", "a"])).toBe("b");
    expect(pickTestModel("missing", [])).toBe("missing");
  });
});

describe("openai listing", () => {
  it("GETs {baseUrl}/v1/models and parses { data: [{ id }] }", async () => {
    const seen = stubFetch((req) => {
      expect(req.url).toBe("http://proxy.local:4000/v1/models");
      expect((req.init?.headers as Record<string, string>)?.authorization).toBe("Bearer sk-x");
      return jsonResponse({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] });
    });
    const provider = new OpenAIProvider({
      kind: "openai",
      baseUrl: "http://proxy.local:4000",
      model: "a",
      apiKey: "sk-x",
    });
    await expect(provider.listModels()).resolves.toEqual({ models: ["a", "b"], source: "listing" });
    expect(seen).toHaveLength(1);
  });

  it("defaults to api.openai.com without a baseUrl", async () => {
    const seen = stubFetch(() => jsonResponse({ data: [] }));
    const provider = new OpenAIProvider({
      kind: "openai",
      baseUrl: null,
      model: "m",
      apiKey: "sk-x",
    });
    await provider.listModels();
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("testConnection uses the listing, not a completion", async () => {
    stubFetch(() => jsonResponse({ data: [{ id: "other" }, { id: "gpt-4o-mini" }] }));
    const provider = new OpenAIProvider({
      kind: "openai",
      baseUrl: null,
      model: "gpt-4o-mini",
      apiKey: "sk-x",
    });
    // If the adapter called a completion, this stub would throw.
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("completion must not be called");
          },
        },
      },
      models: {
        retrieve: async () => {
          throw new Error("models.retrieve must not be called");
        },
      },
    };
    await expect(provider.testConnection()).resolves.toEqual({ ok: true, model: "gpt-4o-mini" });
  });

  it("testConnection falls back to the first model when unlisted", async () => {
    stubFetch(() => jsonResponse({ data: [{ id: "b" }, { id: "a" }] }));
    const provider = new OpenAIProvider({
      kind: "openai",
      baseUrl: null,
      model: "missing",
      apiKey: "sk-x",
    });
    await expect(provider.testConnection()).resolves.toEqual({ ok: true, model: "a" });
  });
});

describe("anthropic listing", () => {
  it("GETs the models endpoint with the version header", async () => {
    const seen = stubFetch((req) => {
      expect(req.url).toBe("https://api.anthropic.com/v1/models");
      const headers = req.init?.headers as Record<string, string>;
      expect(headers?.["x-api-key"]).toBe("sk-ant");
      expect(headers?.["anthropic-version"]).toBe("2023-06-01");
      return jsonResponse({ data: [{ id: "claude-3-5-haiku" }] });
    });
    const provider = new AnthropicProvider({
      kind: "anthropic",
      baseUrl: null,
      model: "claude-3-5-haiku",
      apiKey: "sk-ant",
    });
    await expect(provider.listModels()).resolves.toEqual({
      models: ["claude-3-5-haiku"],
      source: "listing",
    });
    expect(seen).toHaveLength(1);
  });

  it("testConnection uses the listing, not a completion", async () => {
    stubFetch(() => jsonResponse({ data: [{ id: "claude-3-5-haiku" }] }));
    const provider = new AnthropicProvider({
      kind: "anthropic",
      baseUrl: null,
      model: "claude-3-5-haiku",
      apiKey: "sk-ant",
    });
    (provider as unknown as { client: unknown }).client = {
      messages: {
        create: async () => {
          throw new Error("completion must not be called");
        },
        stream: () => {
          throw new Error("stream must not be called");
        },
      },
    };
    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      model: "claude-3-5-haiku",
    });
  });
});

describe("ollama listing", () => {
  it("GETs /api/tags and parses { models: [{ name }] }", async () => {
    const seen = stubFetch((req) => {
      expect(req.url).toBe("http://127.0.0.1:11434/api/tags");
      return jsonResponse({ models: [{ name: "b:latest" }, { name: "a:latest" }] });
    });
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/",
      model: "a:latest",
      apiKey: "",
    });
    await expect(provider.listModels()).resolves.toEqual({
      models: ["a:latest", "b:latest"],
      source: "listing",
    });
    expect(seen).toHaveLength(1);
  });
});

describe("openai-compatible listing", () => {
  it("GETs {baseUrl}/v1/models with the api key and custom headers", async () => {
    const seen = stubFetch((req) => {
      expect(req.url).toBe("http://127.0.0.1:8080/v1/models");
      const headers = req.init?.headers as Record<string, string>;
      expect(headers?.authorization).toBe("Bearer sk-c");
      expect(headers?.["X-Test"]).toBe("abc");
      return jsonResponse({ data: [{ id: "m2" }, { id: "m1" }] });
    });
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "m1",
      apiKey: "sk-c",
      customHeaders: { "X-Test": "abc" },
    });
    await expect(provider.listModels()).resolves.toEqual({
      models: ["m1", "m2"],
      source: "listing",
    });
    expect(seen).toHaveLength(1);
  });

  it("returns an empty fallback on 404/405", async () => {
    for (const status of [404, 405]) {
      stubFetch(() => new Response("not found", { status }));
      const provider = new OpenAICompatibleProvider({
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080",
        model: "m",
        apiKey: "",
      });
      await expect(provider.listModels()).resolves.toEqual({ models: [], source: "fallback" });
    }
  });

  it("testConnection falls back to a minimal completion when listing 404s", async () => {
    const seen = stubFetch((req) => {
      if (req.url.endsWith("/v1/models")) {
        return new Response("not found", { status: 404 });
      }
      expect(req.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(req.init?.method).toBe("POST");
      const body = JSON.parse(String(req.init?.body ?? "{}")) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      });
      expect(body).not.toHaveProperty("stream");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      apiKey: "",
    });
    await expect(provider.testConnection()).resolves.toEqual({ ok: true, model: "m" });
    expect(seen.map((r) => r.url)).toEqual([
      "http://127.0.0.1:8080/v1/models",
      "http://127.0.0.1:8080/v1/chat/completions",
    ]);
  });

  it("testConnection reports the real error with no body when listing fails", async () => {
    stubFetch(() => new Response("secret backend detail", { status: 500 }));
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      apiKey: "",
    });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
      expect(result.error).not.toContain("secret backend detail");
    }
  });
});

describe("ollama cloud vs local", () => {
  it("derives cloud from the baseUrl host", () => {
    expect(isOllamaCloud("https://ollama.com")).toBe(true);
    expect(isOllamaCloud("https://ollama.com/")).toBe(true);
    expect(isOllamaCloud("http://localhost:11434")).toBe(false);
    expect(isOllamaCloud("http://127.0.0.1:11434")).toBe(false);
    expect(isOllamaCloud("http://10.0.0.5:11434")).toBe(false);
    expect(isOllamaCloud("http://192.168.1.10:11434")).toBe(false);
    expect(isOllamaCloud(null)).toBe(false);
    expect(isOllamaCloud(undefined)).toBe(false);
    expect(isOllamaCloud("not a url")).toBe(false);
  });

  it("a local adapter sends no Authorization header on chat, listing, or test", async () => {
    const seen = stubFetch((req) => {
      if (req.url === "http://localhost:11434/api/chat") {
        return new Response(
          '{"message":{"content":"hi"},"done":false}\n{"done":true,"prompt_eval_count":1,"eval_count":1}\n',
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }
      return jsonResponse({ models: [{ name: "m" }] });
    });
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "m",
      apiKey: "",
    });
    const localChunks: unknown[] = [];
    for await (const chunk of provider.complete(
      { messages: [{ role: "user", content: "hi" }], maxTokens: 10, temperature: 0.7 },
      new AbortController().signal,
    )) {
      localChunks.push(chunk);
    }
    expect(localChunks.length).toBeGreaterThan(0);
    await provider.listModels();
    await provider.testConnection();
    expect(seen).toHaveLength(3);
    for (const req of seen) {
      expect(req.init?.headers ?? {}).not.toHaveProperty("authorization");
    }
  });

  it("a cloud adapter sends Bearer auth on chat, listing, and test", async () => {
    const seen = stubFetch((req) => {
      expect(req.url.startsWith("https://ollama.com/api/")).toBe(true);
      if (req.url === "https://ollama.com/api/chat") {
        return new Response(
          '{"message":{"content":"hi"},"done":false}\n{"done":true,"prompt_eval_count":2,"eval_count":1}\n',
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }
      return jsonResponse({ models: [{ name: "m" }] });
    });
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "https://ollama.com",
      model: "m",
      apiKey: "ollama-cloud-key",
    });
    const cloudChunks: unknown[] = [];
    for await (const chunk of provider.complete(
      { messages: [{ role: "user", content: "hi" }], maxTokens: 10, temperature: 0.7 },
      new AbortController().signal,
    )) {
      cloudChunks.push(chunk);
    }
    expect(cloudChunks.length).toBeGreaterThan(0);
    await provider.listModels();
    await expect(provider.testConnection()).resolves.toEqual({ ok: true, model: "m" });
    expect(seen).toHaveLength(3);
    for (const req of seen) {
      expect((req.init?.headers as Record<string, string>)?.authorization).toBe(
        "Bearer ollama-cloud-key",
      );
    }
  });
});
