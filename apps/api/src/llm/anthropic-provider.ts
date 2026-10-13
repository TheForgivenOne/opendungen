import Anthropic from "@anthropic-ai/sdk";
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

// Anthropic adapter (@anthropic-ai/sdk). Explicit cache_control breakpoints
// are placed at cachePrefixUpTo (the stable system prefix). Never logs keys.
export class AnthropicProvider {
  readonly kind: ProviderKind = "anthropic";
  readonly supportsCaching = true;
  readonly supportsMultipleSystemMessages = true;
  readonly tokenMultiplier = 1.0;

  private readonly client: Anthropic;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ProviderConfigInput) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async *complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
    throwIfAborted(signal);
    const { system, messages } = splitMessages(req);
    let stream;
    try {
      stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.topP !== undefined ? { top_p: req.topP } : {}),
          ...(req.stopSequences ? { stop_sequences: req.stopSequences } : {}),
          ...(system ? { system } : {}),
          messages,
        },
        { signal },
      );
    } catch (err) {
      throw mapError(err, signal, this.model);
    }
    // message_start carries message.usage.input_tokens; the last
    // message_delta before message_stop carries usage.output_tokens.
    // Both are emitted together on the final chunk.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const event of stream) {
        throwIfAborted(signal);
        if (event.type === "message_start") {
          const usage = (event.message as { usage?: { input_tokens?: unknown } }).usage;
          if (usage && typeof usage.input_tokens === "number") {
            inputTokens = usage.input_tokens;
          }
        } else if (event.type === "message_delta") {
          const usage = (event as { usage?: { output_tokens?: unknown } }).usage;
          if (usage && typeof usage.output_tokens === "number") {
            outputTokens = usage.output_tokens;
          }
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const text = event.delta.text;
          if (text) {
            yield { delta: text, done: false };
          }
        }
      }
    } catch (err) {
      try {
        stream.abort();
      } catch {
        // ignore cleanup failures
      }
      throw mapError(err, signal, this.model);
    }
    const usage: LLMTokenUsage | undefined =
      inputTokens !== undefined && outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;
    yield { delta: "", done: true, ...(usage ? { usage } : {}) };
  }

  async listModels(): Promise<LLMModelList> {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
    } catch (err) {
      throw new ProviderError("network", `cannot reach the Anthropic API (${networkHint(err)})`);
    }
    if (!res.ok) {
      throw mapStatus(res.status, "model list request failed", this.model);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError(
        "malformed",
        `Anthropic returned a malformed response for model "${this.model}"`,
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
      return { ok: true, model: pickTestModel(this.model, listing.models) };
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: "request aborted" };
      }
      // No listing endpoint on this backend (404/405): fall back to a
      // minimal one-token completion. Anything else is the test result.
      if (
        err instanceof ProviderError &&
        err.status !== undefined &&
        (err.status === 404 || err.status === 405)
      ) {
        return await this.testViaCompletion();
      }
      if (err instanceof ProviderError) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: testErrorMessage(err, this.model) };
    }
  }

  // Minimal one-token completion for backends without a listing
  // endpoint. A Test click on listing backends never reaches this.
  private async testViaCompletion(): Promise<LLMTestResult> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      });
      return { ok: true, model: this.model };
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: "request aborted" };
      }
      return { ok: false, error: testErrorMessage(err, this.model) };
    }
  }
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Anthropic.TextBlockParam[];
}

function splitMessages(req: LLMRequest): {
  system?: Anthropic.TextBlockParam[];
  messages: AnthropicMessage[];
} {
  const cacheAt = req.cachePrefixUpTo ?? 0;
  // Every leading system message (the Layer 1-7 stable prefix) forms
  // the system prompt; Anthropic takes an array of text blocks. The
  // cache breakpoint sits on the last stable block.
  let end = 0;
  while (end < req.messages.length && req.messages[end].role === "system") {
    end += 1;
  }
  const system = req.messages.slice(0, end).map((m, i) => ({
    type: "text" as const,
    text: m.content,
    ...(cacheAt >= 0 && i === end - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const rest = req.messages.slice(end);
  return {
    system: system.length > 0 ? system : undefined,
    messages: rest.map((m, i) =>
      toMessage(m.role === "assistant" ? "assistant" : "user", m.content, cacheAt === end + i),
    ),
  };
}

function toMessage(
  role: "user" | "assistant",
  content: string,
  cacheable: boolean,
): AnthropicMessage {
  if (!cacheable) {
    return { role, content };
  }
  return {
    role,
    content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }],
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError();
  }
}

function mapError(err: unknown, signal: AbortSignal, model: string): Error {
  if (err instanceof AbortError || isAbortError(err, signal)) {
    return new AbortError();
  }
  if (err instanceof Anthropic.APIError) {
    return mapStatus(err.status, err.message || "Anthropic request failed", model);
  }
  if (isNetworkFailure(err)) {
    return new ProviderError("network", `cannot reach the Anthropic API (${networkHint(err)})`);
  }
  return new ProviderError(
    "unknown",
    err instanceof Error ? err.message : `Anthropic request for model "${model}" failed`,
  );
}

function mapStatus(status: number | undefined, message: string, model: string): ProviderError {
  if (status === 401) {
    return new ProviderError("auth", "Anthropic rejected the API key (401)", 401);
  }
  if (status === 429) {
    return new ProviderError("rate_limit", "Anthropic rate limit exceeded (429)", 429);
  }
  if (status === 404) {
    return new ProviderError("model_not_found", `Anthropic model "${model}" not found (404)`, 404);
  }
  return new ProviderError(
    "unknown",
    `Anthropic request failed (${status ?? "no status"}): ${message}`,
    status,
  );
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return true;
  }
  return /fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message);
}

function networkHint(err: unknown): string {
  if (err instanceof Error) {
    const match = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.exec(err.message);
    if (match) {
      return match[0];
    }
  }
  return "network error";
}

function testErrorMessage(err: unknown, model: string): string {
  if (err instanceof Anthropic.APIError) {
    return mapStatus(err.status, err.message || "request failed", model).message;
  }
  if (isNetworkFailure(err)) {
    return `cannot reach the Anthropic API (${networkHint(err)})`;
  }
  return err instanceof Error ? err.message : "connection test failed";
}
