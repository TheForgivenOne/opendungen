// LLM provider abstraction. Every adapter implements LLMProvider.
// Original implementation; no vendor prompts or assets are bundled.

export type ProviderKind = "openai" | "anthropic" | "ollama" | "openai-compatible";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "openai",
  "anthropic",
  "ollama",
  "openai-compatible",
];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  maxTokens: number;
  temperature: number;
  topP?: number;
  stopSequences?: string[];
  // Cache hint: index into messages up to and including which the
  // prefix is stable. Adapters that support caching use this.
  cachePrefixUpTo?: number;
}

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMChunk {
  delta: string;
  done: boolean;
  // Only the final chunk carries usage. Intermediate chunks leave it
  // undefined; adapters whose backend omits usage leave it undefined
  // on the final chunk too (never an error).
  usage?: LLMTokenUsage;
}

export interface LLMModelList {
  models: string[];
  source: "listing" | "fallback";
}

export interface LLMTestSuccess {
  ok: true;
  model: string;
}

export interface LLMTestFailure {
  ok: false;
  error: string;
}

export type LLMTestResult = LLMTestSuccess | LLMTestFailure;

export interface LLMProvider {
  readonly kind: ProviderKind;
  readonly supportsCaching: boolean;
  // False when the backend rejects multiple system messages: the
  // pipeline then joins all system blocks into one leading system
  // message. True for openai and anthropic, false for
  // openai-compatible and ollama.
  readonly supportsMultipleSystemMessages: boolean;
  readonly tokenMultiplier: number;
  complete(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMChunk>;
  testConnection(): Promise<LLMTestResult>;
  // Model ids from the provider's listing endpoint, deduplicated and
  // sorted (cap 500). openai-compatible answers { models: [], source:
  // 'fallback' } when the backend has no listing endpoint (404/405).
  listModels(): Promise<LLMModelList>;
}

// Decrypted provider configuration handed to the factory. apiKey may be
// empty for keyless local providers (Ollama); adapters must cope.
export interface ProviderConfigInput {
  kind: ProviderKind;
  baseUrl: string | null;
  model: string;
  apiKey: string;
  // Only the openai-compatible adapter sends these; every other
  // adapter ignores the value when set.
  customHeaders?: Record<string, string> | null;
}

// Thrown when generation is aborted via the AbortSignal. Adapters stop
// reading the stream and throw this; the pipeline treats it as
// "keep the input action, drop any partial output".
export class AbortError extends Error {
  readonly code = "abort" as const;

  constructor(message = "request aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export type ProviderErrorCode =
  | "auth"
  | "rate_limit"
  | "model_not_found"
  | "network"
  | "malformed"
  | "unknown"
  | "timeout_ttft"
  | "timeout_total"
  | "empty_completion";

// Typed adapter failure. Messages are safe to surface to the user;
// adapters must never include API keys in them.
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

// True for AbortError, DOM abort exceptions, or an already-aborted signal.
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof AbortError) {
    return true;
  }
  if (signal?.aborted) {
    return true;
  }
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"))
  );
}

export function providerErrorMessage(err: unknown): string {
  if (err instanceof ProviderError || err instanceof AbortError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "provider request failed";
}
