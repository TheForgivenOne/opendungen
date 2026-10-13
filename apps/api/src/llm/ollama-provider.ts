import { normalizeModelList, pickTestModel } from "./listing";
import {
  AbortError,
  ProviderError,
  isAbortError,
  type LLMChunk,
  type LLMModelList,
  type LLMRequest,
  type LLMTestResult,
  type LLMTokenUsage,
  type ProviderConfigInput,
  type ProviderKind,
} from "./types";

// Ollama adapter: plain fetch to {baseUrl}/api/chat, NDJSON stream.
// Keyless local servers are normal, so an empty apiKey is fine —
// unless the baseUrl points at Ollama Cloud (see isOllamaCloud),
// which requires `Authorization: Bearer <apiKey>` on every request.
// The hosted service exposes the identical API surface as a local
// server (/api/chat, /api/tags, same usage fields). Never logs
// request bodies or keys.
export class OllamaProvider {
  readonly kind: ProviderKind = "ollama";
  readonly supportsCaching = false;
  readonly supportsMultipleSystemMessages = false;
  readonly tokenMultiplier = 1.0;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly cloud: boolean;

  constructor(config: ProviderConfigInput) {
    if (!config.baseUrl) {
      throw new ProviderError("unknown", "Ollama requires a baseUrl");
    }
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.cloud = isOllamaCloud(config.baseUrl);
  }

  // Bearer auth rides on every request for Ollama Cloud; local
  // servers get no Authorization header at all.
  private authHeaders(): Record<string, string> {
    if (this.cloud && this.apiKey) {
      return { authorization: `Bearer ${this.apiKey}` };
    }
    return {};
  }

  async *complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
    throwIfAborted(signal);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          options: {
            num_predict: req.maxTokens,
            temperature: req.temperature,
            ...(req.topP !== undefined ? { top_p: req.topP } : {}),
            ...(req.stopSequences ? { stop: req.stopSequences } : {}),
          },
        }),
        signal,
      });
    } catch (err) {
      throw mapError(err, signal, this.baseUrl);
    }
    if (!res.ok || !res.body) {
      throw await mapHttpError(res, this.model);
    }
    // The final NDJSON line carries done:true plus prompt_eval_count /
    // eval_count; both are emitted together on the final chunk.
    let usage: LLMTokenUsage | undefined;
    try {
      for await (const line of readLines(res.body, signal)) {
        throwIfAborted(signal);
        const parsed = parseLine(line, this.model);
        if (parsed.usage) {
          usage = parsed.usage;
        }
        if (parsed.done) {
          break;
        }
        if (parsed.text) {
          yield { delta: parsed.text, done: false };
        }
      }
    } catch (err) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore cleanup failures
      }
      throw mapError(err, signal, this.baseUrl);
    }
    yield { delta: "", done: true, ...(usage ? { usage } : {}) };
  }

  async listModels(): Promise<LLMModelList> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.authHeaders(),
      });
    } catch (err) {
      throw new ProviderError(
        "network",
        `cannot reach Ollama at ${this.baseUrl} (${networkHint(err)})`,
      );
    }
    if (!res.ok) {
      throw await mapHttpError(res, this.model);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(
        "malformed",
        `Ollama returned a malformed response for model "${this.model}"`,
      );
    }
    const models = (body as { models?: { name?: unknown; model?: unknown }[] }).models;
    const ids = Array.isArray(models)
      ? models.map((m) => (typeof m.name === "string" ? m.name : m.model))
      : [];
    return { models: normalizeModelList(ids), source: "listing" };
  }

  async testConnection(): Promise<LLMTestResult> {
    try {
      const listing = await this.listModels();
      return { ok: true, model: pickTestModel(this.model, listing.models) };
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: "request aborted" };
      }
      // No listing endpoint on this server (404/405): fall back to a
      // minimal one-token completion. Anything else is the test result.
      if (
        err instanceof ProviderError &&
        err.status !== undefined &&
        (err.status === 404 || err.status === 405)
      ) {
        return await this.testViaCompletion();
      }
      return {
        ok: false,
        error:
          err instanceof ProviderError
            ? err.message
            : `cannot reach Ollama at ${this.baseUrl} (${networkHint(err)})`,
      };
    }
  }

  // Minimal one-token completion for servers without a listing
  // endpoint. A Test click on listing servers never reaches this.
  private async testViaCompletion(): Promise<LLMTestResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "test" }],
          stream: false,
          options: { num_predict: 1 },
        }),
      });
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: "request aborted" };
      }
      return {
        ok: false,
        error: `cannot reach Ollama at ${this.baseUrl} (${networkHint(err)})`,
      };
    }
    if (!res.ok) {
      const mapped = await mapHttpError(res, this.model);
      return { ok: false, error: mapped.message };
    }
    return { ok: true, model: this.model };
  }
}

export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

// Cloud vs local is derived from the baseUrl at runtime — there is no
// separate provider kind. A host of ollama.com (or a subdomain of it)
// is the hosted service; anything else (localhost, LAN IPs, tunnels)
// is a local-style server. Unparseable input is local (never cloud).
export function isOllamaCloud(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return false;
  }
  return hostname === "ollama.com" || hostname.endsWith(".ollama.com");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError();
  }
}

function mapError(err: unknown, signal: AbortSignal, baseUrl: string): Error {
  if (err instanceof AbortError || isAbortError(err, signal)) {
    return new AbortError();
  }
  if (err instanceof ProviderError) {
    return err;
  }
  return new ProviderError("network", `cannot reach Ollama at ${baseUrl} (${networkHint(err)})`);
}

async function mapHttpError(res: Response, model: string): Promise<ProviderError> {
  if (res.status === 401) {
    return new ProviderError("auth", "Ollama rejected the request (401)", 401);
  }
  if (res.status === 429) {
    return new ProviderError("rate_limit", "Ollama rate limit exceeded (429)", 429);
  }
  if (res.status === 404) {
    return new ProviderError("model_not_found", `Ollama model "${model}" not found (404)`, 404);
  }
  return new ProviderError("unknown", `Ollama request failed (${res.status})`, res.status);
}

function networkHint(err: unknown): string {
  if (err instanceof Error) {
    const match = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.exec(err.message);
    if (match) {
      return match[0];
    }
    return err.message;
  }
  return "network error";
}

interface ParsedLine {
  text: string;
  done: boolean;
  usage?: LLMTokenUsage;
}

// Ollama NDJSON line: {"message":{"content":"..."},"done":false}
// or {"done":true,"prompt_eval_count":N,"eval_count":M},
// or {"error":"..."} on failure.
export function parseLine(line: string, model: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return { text: "", done: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProviderError(
      "malformed",
      `Ollama returned a malformed response for model "${model}"`,
    );
  }
  const obj = parsed as {
    message?: { content?: unknown };
    error?: unknown;
    done?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  if (typeof obj.error === "string" && obj.error) {
    if (/not found/i.test(obj.error)) {
      throw new ProviderError("model_not_found", `Ollama model "${model}" not found`);
    }
    throw new ProviderError("unknown", `Ollama error: ${obj.error}`);
  }
  const done = obj.done === true;
  let usage: LLMTokenUsage | undefined;
  if (done && typeof obj.prompt_eval_count === "number" && typeof obj.eval_count === "number") {
    usage = { inputTokens: obj.prompt_eval_count, outputTokens: obj.eval_count };
  }
  const content = obj.message?.content;
  return { text: typeof content === "string" ? content : "", done, ...(usage ? { usage } : {}) };
}

// Kept for backwards compatibility with existing imports.
export function extractDelta(line: string, model: string): string {
  return parseLine(line, model).text;
}

// Streams text lines from a fetch body, honouring abort promptly.
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      if (signal.aborted) {
        throw new AbortError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        yield part;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      yield buffered;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore cleanup failures
    }
  }
}
