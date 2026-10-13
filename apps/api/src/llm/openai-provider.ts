import OpenAI from "openai";
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

// OpenAI adapter (openai SDK). Prefix caching is automatic for prompts
// over ~1024 tokens — nothing is sent to enable it. Never logs API keys.
export class OpenAIProvider {
  readonly kind: ProviderKind = "openai";
  readonly supportsCaching = true;
  readonly supportsMultipleSystemMessages = true;
  readonly tokenMultiplier = 1.0;

  private readonly client: OpenAI;
  private readonly baseUrl: string | null;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ProviderConfigInput) {
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async *complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk> {
    throwIfAborted(signal);
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.topP !== undefined ? { top_p: req.topP } : {}),
          ...(req.stopSequences ? { stop: req.stopSequences } : {}),
          stream: true,
          // Ask for usage on the final chunk. Backends that ignore the
          // flag simply omit usage — never an error.
          stream_options: { include_usage: true },
        },
        { signal },
      );
    } catch (err) {
      throw mapError(err, signal, this.model);
    }
    let usage: LLMTokenUsage | undefined;
    try {
      for await (const part of stream) {
        throwIfAborted(signal);
        const chunkUsage = (
          part as {
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
          }
        ).usage;
        if (
          chunkUsage &&
          typeof chunkUsage.prompt_tokens === "number" &&
          typeof chunkUsage.completion_tokens === "number"
        ) {
          usage = {
            inputTokens: chunkUsage.prompt_tokens,
            outputTokens: chunkUsage.completion_tokens,
          };
        }
        const delta = part.choices[0]?.delta?.content ?? "";
        if (delta) {
          yield { delta, done: false };
        }
      }
    } catch (err) {
      // The request signal already governs cancellation; exiting the
      // loop stops reading the stream.
      throw mapError(err, signal, this.model);
    }
    yield { delta: "", done: true, ...(usage ? { usage } : {}) };
  }

  async listModels(): Promise<LLMModelList> {
    const base = this.baseUrl ? this.baseUrl.replace(/\/+$/, "") : "https://api.openai.com";
    let res: Response;
    try {
      res = await fetch(`${base}/v1/models`, {
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });
    } catch (err) {
      throw new ProviderError("network", `cannot reach the OpenAI API (${networkHint(err)})`);
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
        `OpenAI returned a malformed response for model "${this.model}"`,
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
      await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError();
  }
}

function mapError(err: unknown, signal: AbortSignal, model: string): Error {
  if (err instanceof AbortError || isAbortError(err, signal)) {
    return new AbortError();
  }
  if (err instanceof OpenAI.APIError) {
    return mapStatus(err.status, err.message || `OpenAI request failed`, model);
  }
  if (isNetworkFailure(err)) {
    return new ProviderError("network", `cannot reach the OpenAI API (${networkHint(err)})`);
  }
  return new ProviderError(
    "unknown",
    err instanceof Error ? err.message : `OpenAI request for model "${model}" failed`,
  );
}

function mapStatus(status: number | undefined, message: string, model: string): ProviderError {
  if (status === 401) {
    return new ProviderError("auth", "OpenAI rejected the API key (401)", 401);
  }
  if (status === 429) {
    return new ProviderError("rate_limit", "OpenAI rate limit exceeded (429)", 429);
  }
  if (status === 404) {
    return new ProviderError("model_not_found", `OpenAI model "${model}" not found (404)`, 404);
  }
  return new ProviderError(
    "unknown",
    `OpenAI request failed (${status ?? "no status"}): ${message}`,
    status,
  );
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError) {
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
  if (err instanceof OpenAI.APIError) {
    return mapStatus(err.status, err.message || "request failed", model).message;
  }
  if (isNetworkFailure(err)) {
    return `cannot reach the OpenAI API (${networkHint(err)})`;
  }
  return err instanceof Error ? err.message : "connection test failed";
}
