// Per-adapter real-usage extraction: each adapter parses a fixture
// stream carrying usage and emits it on the final chunk only; a stream
// without usage emits undefined (never an error).

import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic-provider";
import { OllamaProvider } from "./ollama-provider";
import {
  OpenAICompatibleProvider,
  __clearStreamOptionsCacheForTests,
} from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import type { LLMChunk } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  __clearStreamOptionsCacheForTests();
});

async function collect(
  iterable: AsyncIterable<LLMChunk>,
): Promise<{ deltas: string[]; chunks: LLMChunk[] }> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return {
    deltas: chunks.filter((c) => !c.done).map((c) => c.delta),
    chunks,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      return handler(String(url), init);
    }),
  );
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function sseResponse(payloads: (string | object)[]): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}`)
    .join("\n\n");
  return new Response(body.length > 0 ? `${body}\n\n` : "", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const REQ = {
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 100,
  temperature: 0.7,
};

const ISO_CHUNK = { choices: [{ delta: { content: "x" } }] };

describe("openai usage", () => {
  function providerWithStream(parts: unknown[], onCreate?: (params: unknown) => void) {
    const provider = new OpenAIProvider({
      kind: "openai",
      baseUrl: null,
      model: "gpt-4o-mini",
      apiKey: "x",
    });
    async function* stream() {
      for (const part of parts) {
        yield part as never;
      }
    }
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            onCreate?.(params);
            return stream();
          },
        },
      },
    };
    return provider;
  }

  it("sends stream_options and emits usage on the final chunk", async () => {
    let sent: unknown;
    const provider = providerWithStream(
      [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ],
      (params) => {
        sent = params;
      },
    );
    const { deltas, chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(deltas).toEqual(["Hello", " world"]);
    expect(sent).toMatchObject({ stream_options: { include_usage: true } });
    const finals = chunks.filter((c) => c.done);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({
      delta: "",
      done: true,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    // Intermediate chunks carry no usage.
    expect(chunks.filter((c) => !c.done).every((c) => c.usage === undefined)).toBe(true);
  });

  it("emits undefined usage when the backend omits it", async () => {
    const provider = providerWithStream([{ choices: [{ delta: { content: "Hi" } }] }]);
    const { chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    const finals = chunks.filter((c) => c.done);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.usage).toBeUndefined();
  });
});

describe("anthropic usage", () => {
  function providerWithEvents(events: unknown[]) {
    const provider = new AnthropicProvider({
      kind: "anthropic",
      baseUrl: null,
      model: "claude-3-5-haiku",
      apiKey: "x",
    });
    async function* stream() {
      for (const event of events) {
        yield event as never;
      }
    }
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: () => stream() },
    };
    return provider;
  }

  it("emits input/output tokens from message_start/message_delta", async () => {
    const provider = providerWithEvents([
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hey" } },
      { type: "message_delta", usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]);
    const { deltas, chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(deltas).toEqual(["Hey"]);
    const finals = chunks.filter((c) => c.done);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({
      delta: "",
      done: true,
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it("uses the last message_delta for output tokens", async () => {
    const provider = providerWithEvents([
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "message_delta", usage: { output_tokens: 2 } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      { type: "message_delta", usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);
    const { chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(chunks.filter((c) => c.done)[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
  });

  it("emits undefined usage when the stream carries none", async () => {
    const provider = providerWithEvents([
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hey" } },
    ]);
    const { chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(chunks.filter((c) => c.done)[0]?.usage).toBeUndefined();
  });
});

describe("ollama usage", () => {
  it("emits prompt_eval_count/eval_count from the final line", async () => {
    stubFetch((url) => {
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      return ndjsonResponse([
        JSON.stringify({ message: { content: "Hello" }, done: false }),
        JSON.stringify({ done: true, prompt_eval_count: 14, eval_count: 6 }),
      ]);
    });
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      apiKey: "",
    });
    const { deltas, chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(deltas).toEqual(["Hello"]);
    expect(chunks.filter((c) => c.done)[0]).toEqual({
      delta: "",
      done: true,
      usage: { inputTokens: 14, outputTokens: 6 },
    });
  });

  it("emits undefined usage when the final line omits counts", async () => {
    stubFetch(() =>
      ndjsonResponse([
        JSON.stringify({ message: { content: "Hi" }, done: false }),
        JSON.stringify({ done: true }),
      ]),
    );
    const provider = new OllamaProvider({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      apiKey: "",
    });
    const { chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(chunks.filter((c) => c.done)[0]?.usage).toBeUndefined();
  });
});

describe("openai-compatible usage", () => {
  it("emits usage from the final choices:[] chunk", async () => {
    const seen: { url: string; body: string }[] = [];
    stubFetch(async (url, init) => {
      seen.push({ url, body: String(init?.body ?? "") });
      return sseResponse([
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
        "[DONE]",
      ]);
    });
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "local",
      apiKey: "",
    });
    const { deltas, chunks } = await collect(provider.complete(REQ, new AbortController().signal));
    expect(deltas).toEqual(["Hello"]);
    expect(chunks.filter((c) => c.done)[0]).toEqual({
      delta: "",
      done: true,
      usage: { inputTokens: 20, outputTokens: 8 },
    });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      stream_options: { include_usage: true },
    });
  });

  it("retries once without stream_options on a 400 naming the flag, and caches it", async () => {
    const bodies: string[] = [];
    stubFetch(async (_url, init) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      if (body.includes("stream_options")) {
        return new Response(
          JSON.stringify({ error: { message: "Unrecognized request argument: stream_options" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return sseResponse([ISO_CHUNK, "[DONE]"]);
    });
    const config = {
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:8080",
      model: "local",
      apiKey: "",
    };
    const first = new OpenAICompatibleProvider(config);
    const firstRun = await collect(first.complete(REQ, new AbortController().signal));
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(JSON.parse(bodies[1] ?? "{}")).not.toHaveProperty("stream_options");
    // Usage is undefined for the retried call — never an error.
    expect(firstRun.chunks.filter((c) => c.done)[0]?.usage).toBeUndefined();

    // A later call for the same endpoint skips the flag outright.
    bodies.length = 0;
    const second = new OpenAICompatibleProvider(config);
    await collect(second.complete(REQ, new AbortController().signal));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? "{}")).not.toHaveProperty("stream_options");
  });

  it("surfaces other 400s without retrying", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new OpenAICompatibleProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080",
      model: "local",
      apiKey: "",
    });
    await expect(
      collect(provider.complete(REQ, new AbortController().signal)),
    ).rejects.toMatchObject({ code: "unknown" });
    expect(calls).toBe(1);
  });
});
