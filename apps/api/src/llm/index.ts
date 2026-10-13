import { AnthropicProvider } from "./anthropic-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import {
  ProviderError,
  isProviderKind,
  type LLMProvider,
  type ProviderConfigInput,
  type ProviderKind,
} from "./types";

export * from "./types";
export { OpenAIProvider } from "./openai-provider";
export { AnthropicProvider } from "./anthropic-provider";
export { OllamaProvider } from "./ollama-provider";
export { OpenAICompatibleProvider } from "./openai-compatible-provider";

// Factory: dispatches on kind. Throws ProviderError on unknown kind or
// missing fields so callers get a typed error, never undefined.
export function createProvider(config: ProviderConfigInput): LLMProvider {
  const kind: ProviderKind = config.kind;
  if (!isProviderKind(kind)) {
    throw new ProviderError("unknown", `unknown provider kind: ${String(kind)}`);
  }
  if (!config.model) {
    throw new ProviderError("unknown", "provider model is required");
  }
  switch (kind) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
  }
}
