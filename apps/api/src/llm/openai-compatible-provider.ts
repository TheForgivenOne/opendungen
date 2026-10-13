import { normalizeModelList, pickTestModel } from "./listing";
import { normalizeBaseUrl, readLines } from "./ollama-provider";
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

// OpenAI-compatible adapter: plain fetch to {baseUrl}/v1/chat/completions,
// SSE stream. Caching off by default (unknown server semantics).
// Never logs API keys, custom headers, or request bodies.

// Backends that reject `stream_options` (400 mentioning the flag) get
// one retry without it; the fact is cached per endpoint in module scope
// so subsequent calls skip the flag outright. Usage is then undefined
// for those calls — never an error.
const noStreamOptionsEndpoints = new Set<string>();

export function __clearStreamOptionsCacheForTests(): void {
  noStreamOptionsEndpoints.clear();
}

function skipsStreamOptions(baseUrl: string): boolean {
  return noStreamOptionsEndpoints.has(baseUrl);
}

export class OpenAICompatibleProvider {
  readonly kind: ProviderKind = "openai-compatible";
  readonly supportsCaching = false;
  readonly supportsMultipleSystemMessages = false;
  readonly tokenMultiplier = 1.0;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly customHeaders: Record<string, string>;

  constructor(config: ProviderConfigInput) {
    if (!config.baseUrl) {
      throw new ProviderError("unknown", "openai-compatible requires a baseUrl");
    }
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.customHeaders = config.customHeaders ?? {};
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      // Custom headers ride on every request, including listing and
      // testConnection. They are validated on write and never logged.
      ...this.customHeaders,
      ...extra,
    };
  }

  private chatBody(req: LLMRequest, withUsage: boolean): Record<string, unknown> {
    return {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.stopSequences ? { stop: req.stopSequences } : {}),
      stream: true,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
    };
  }

  async *complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
    throwIfAborted(signal);
    const withUsage = !skipsStreamOptions(this.baseUrl);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(this.chatBody(req, withUsage)),
        signal,
      });
    } catch (err) {
      throw mapError(err, signal, this.baseUrl);
    }
    // Some backends do not support stream_options: on a 400 that names
    // the flag, retry once without it and mark usage undefined.
    if (!res.ok && res.status === 400 && withUsage) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }
      if (/stream_options/i.test(text)) {
        noStreamOptionsEndpoints.add(this.baseUrl);
        try {
          res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: this.headers({ "content-type": "application/json" }),
            body: JSON.stringify(this.chatBody(req, false)),
            signal,
          });
        } catch (err) {
          throw mapError(err, signal, this.baseUrl);
        }
      } else {
        throw await mapHttpError(res.status, this.model);
      }
    }
    if (!res.ok || !res.body) {
      throw await mapHttpError(res.status, this.model);
    }
    // The final chunk has choices:[] plus a usage object with
    // prompt_tokens / completion_tokens.
    let usage: LLMTokenUsage | undefined;
    try {
      for await (const line of readLines(res.body, signal)) {
        throwIfAborted(signal);
        const parsed = extractChunk(line, this.model);
        if (parsed === null) {
          // "[DONE]" terminator.
          break;
        }
        if (parsed.usage) {
          usage = parsed.usage;
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
      res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
      });
    } catch (err) {
      throw new ProviderError(
        "network",
        `cannot reach the endpoint at ${this.baseUrl} (${networkHint(err)})`,
      );
    }
    if (res.status === 404 || res.status === 405) {
      // No listing endpoint on this backend: callers fall back to a
      // minimal completion for testConnection, and the models route
      // reports an empty fallback list.
      return { models: [], source: "fallback" };
    }
    if (!res.ok) {
      throw await mapHttpError(res.status, this.model);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(
        "malformed",
        `endpoint returned a malformed response for model "${this.model}"`,
      );
    }
    const data = (body as { data?: { id?: unknown }[] }).data;
    return {
      models: normalizeModelList(Array.isArray(data) ? data.map((m) => m.id) : []),
      source: "listing",
    };
  }

  async testConnection(): Promise<LLMTestResult> {
    try {
      const listing = await this.listModels();
      if (listing.source === "fallback") {
        return await this.testViaCompletion();
      }
      return { ok: true, model: pickTestModel(this.model, listing.models) };
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: "request aborted" };
      }
      return {
        ok: false,
        error:
          err instanceof ProviderError
            ? err.message
            : `cannot reach the endpoint at ${this.baseUrl} (${networkHint(err)})`,
      };
    }
  }

  // Minimal one-token completion for backends without a listing
  // endpoint. A Test click on other backends never reaches this.
  private async testViaCompletion(): Promise<LLMTestResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1,
        }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `cannot reach the endpoint at ${this.baseUrl} (${networkHint(err)})`,
      };
    }
    if (!res.ok) {
      const mapped = await mapHttpError(res.status, this.model);
      return { ok: false, error: mapped.message };
    }
    return { ok: true, model: this.model };
  }
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
  return new ProviderError(
    "network",
    `cannot reach the endpoint at ${baseUrl} (${networkHint(err)})`,
  );
}

async function mapHttpError(status: number, model: string): Promise<ProviderError> {
  if (status === 401) {
    return new ProviderError("auth", "server rejected the API key (401)", 401);
  }
  if (status === 429) {
    return new ProviderError("rate_limit", "server rate limit exceeded (429)", 429);
  }
  if (status === 404) {
    return new ProviderError("model_not_found", `model "${model}" not found (404)`, 404);
  }
  return new ProviderError("unknown", `request failed (${status})`, status);
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

interface ParsedChunk {
  text: string;
  usage?: LLMTokenUsage;
}

// SSE line from /chat/completions. Returns null on the "[DONE]"
// terminator, otherwise the text delta and/or the usage object (the
// final chunk carries choices:[] plus usage).
export function extractChunk(line: string, model: string): ParsedChunk | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return { text: "" };
  }
  const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
  if (payload === "[DONE]") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ProviderError(
      "malformed",
      `endpoint returned a malformed response for model "${model}"`,
    );
  }
  const obj = parsed as {
    choices?: { delta?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    error?: unknown;
  };
  if (obj.error !== undefined && obj.error !== null) {
    const message =
      typeof obj.error === "object"
        ? String((obj.error as { message?: unknown }).message ?? "unknown error")
        : String(obj.error);
    throw new ProviderError("unknown", `endpoint error: ${message}`);
  }
  let usage: LLMTokenUsage | undefined;
  if (
    obj.usage &&
    typeof obj.usage.prompt_tokens === "number" &&
    typeof obj.usage.completion_tokens === "number"
  ) {
    usage = { inputTokens: obj.usage.prompt_tokens, outputTokens: obj.usage.completion_tokens };
  }
  const content = obj.choices?.[0]?.delta?.content;
  return {
    text: typeof content === "string" ? content : "",
    ...(usage ? { usage } : {}),
  };
}

// Kept for backwards compatibility with existing imports: the text
// delta only (null terminator maps to null, as before).
export function extractDelta(line: string, model: string): string | null {
  const parsed = extractChunk(line, model);
  return parsed === null ? null : parsed.text;
}
