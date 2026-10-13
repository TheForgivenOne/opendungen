// Ollama Cloud auth regression: Bearer must ride on every request —
// the /api/chat stream, the /api/tags listing, and the minimal
// one-token completion fallback. Local servers send nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "./ollama-provider";

afterEach(() => {
  vi.unstubAllGlobals();
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

function headerOf(seen: SeenRequest, name: string): string | null {
  const headers = seen.init?.headers as Record<string, string> | undefined;
  if (!headers) {
    return null;
  }
  const found = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return found ? found[1] : null;
}

function ndjsonChatResponse(): Response {
  const body =
    '{"message":{"content":"hi"},"done":false}\n' +
    '{"done":true,"prompt_eval_count":1,"eval_count":1}\n';
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function cloudProvider() {
  return new OllamaProvider({
    kind: "ollama",
    baseUrl: "https://ollama.com",
    model: "gpt-oss:20b",
    apiKey: "cloud-key",
  });
}

describe("ollama cloud auth", () => {
  it("sends Bearer on the /api/chat stream", async () => {
    const seen = stubFetch(() => ndjsonChatResponse());
    const provider = cloudProvider();
    const chunks = [];
    for await (const chunk of provider.complete(
      { messages: [{ role: "user", content: "hi" }], maxTokens: 10, temperature: 0.7 },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const chat = seen.filter((r) => r.url.endsWith("/api/chat"));
    expect(chat).toHaveLength(1);
    expect(headerOf(chat[0], "authorization")).toBe("Bearer cloud-key");
  });

  it("sends Bearer on the /api/tags listing (test path)", async () => {
    const seen = stubFetch((r) =>
      r.url.endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "gpt-oss:20b" }] }), { status: 200 })
        : new Response("not found", { status: 404 }),
    );
    const result = await cloudProvider().testConnection();
    expect(result).toMatchObject({ ok: true });
    const tags = seen.filter((r) => r.url.endsWith("/api/tags"));
    expect(tags).toHaveLength(1);
    expect(headerOf(tags[0], "authorization")).toBe("Bearer cloud-key");
  });

  it("sends Bearer on the completion fallback when listing is absent", async () => {
    const seen = stubFetch((r) =>
      r.url.endsWith("/api/tags")
        ? new Response("no listing here", { status: 404 })
        : new Response(JSON.stringify({ message: { content: "ok" }, done: true }), {
            status: 200,
          }),
    );
    const result = await cloudProvider().testConnection();
    expect(result).toMatchObject({ ok: true });
    const chat = seen.filter((r) => r.url.endsWith("/api/chat"));
    expect(chat).toHaveLength(1);
    expect(headerOf(chat[0], "authorization")).toBe("Bearer cloud-key");
  });

  it("sends no Authorization header for local servers", async () => {
    const seen = stubFetch(() => ndjsonChatResponse());
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
      apiKey: "",
    });
    for await (const _ of provider.complete(
      { messages: [{ role: "user", content: "hi" }], maxTokens: 10, temperature: 0.7 },
      new AbortController().signal,
    )) {
      // drain
    }
    const chat = seen.filter((r) => r.url.endsWith("/api/chat"));
    expect(chat).toHaveLength(1);
    expect(headerOf(chat[0], "authorization")).toBeNull();
  });
});
