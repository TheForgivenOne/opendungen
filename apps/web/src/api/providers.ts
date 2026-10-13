import { post, request } from "./client";

export type ProviderKind = "openai" | "anthropic" | "ollama" | "openai-compatible";

export const PROVIDER_KINDS: { value: ProviderKind; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
];

export function providerNeedsBaseUrl(kind: ProviderKind): boolean {
  return kind === "ollama" || kind === "openai-compatible";
}

// Display name for a provider row or badge: the label renders only
// when it differs from the model name, so "gpt-oss:20b · gpt-oss:20b"
// never appears. Empty labels fall back to the model; both empty
// renders nothing.
export function providerDisplayName(provider: { label: string; model: string }): string {
  const label = provider.label.trim();
  const model = provider.model.trim();
  if (!label && !model) {
    return "";
  }
  if (!label || label === provider.model) {
    return provider.model;
  }
  return `${provider.label} · ${provider.model}`;
}

// Suggested default label for the Add provider form, by kind. This is
// a real input value (not a placeholder) so submitting untouched works.
export function suggestedProviderLabel(kind: ProviderKind, baseUrl: string): string {
  if (kind === "ollama") {
    try {
      const host = new URL(baseUrl).hostname.replace(/\.$/, "").toLowerCase();
      if (host === "ollama.com" || host.endsWith(".ollama.com")) {
        return "Ollama Cloud";
      }
    } catch {
      // Unparseable URL: still a local-style server.
    }
    return "Ollama (local)";
  }
  if (kind === "openai") {
    return "OpenAI";
  }
  if (kind === "anthropic") {
    return "Anthropic";
  }
  return "Custom endpoint";
}

export function isSuggestedProviderLabel(label: string): boolean {
  return (
    label === "Ollama (local)" ||
    label === "Ollama Cloud" ||
    label === "OpenAI" ||
    label === "Anthropic" ||
    label === "Custom endpoint"
  );
}

export interface Provider {
  id: string;
  userId: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  createdAt: number;
  // The raw custom headers are never returned — only whether any exist.
  hasCustomHeaders: boolean;
  // Null = server defaults (60s TTFT, 180s total).
  ttftTimeoutMs: number | null;
  totalTimeoutMs: number | null;
}

export interface ProviderForm {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  // Raw JSON text for the custom-headers textarea (compat kind only).
  customHeaders: string;
  // Raw numeric text; "" means the server default.
  ttftTimeoutMs: string;
  totalTimeoutMs: string;
}

export interface ModelListing {
  models: string[];
  source: "listing" | "fallback";
}

export function listModels(id: string): Promise<ModelListing> {
  return request(`/api/providers/${id}/models`);
}

export function listProviders(): Promise<{ providers: Provider[] }> {
  return request("/api/providers");
}

function parseTimeoutMs(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseCustomHeaders(text: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("custom headers must be a JSON object");
  }
  return parsed as Record<string, string>;
}

export function createProvider(form: ProviderForm): Promise<{ provider: Provider }> {
  return post("/api/providers", {
    label: form.label,
    kind: form.kind,
    ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}),
    model: form.model,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    ...(form.ttftTimeoutMs.trim() ? { ttftTimeoutMs: parseTimeoutMs(form.ttftTimeoutMs) } : {}),
    ...(form.totalTimeoutMs.trim() ? { totalTimeoutMs: parseTimeoutMs(form.totalTimeoutMs) } : {}),
    ...(form.customHeaders.trim() ? { customHeaders: parseCustomHeaders(form.customHeaders) } : {}),
  });
}

export function patchProvider(
  id: string,
  patch: Partial<ProviderForm>,
): Promise<{ provider: Provider }> {
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined) {
    body.label = patch.label;
  }
  if (patch.kind !== undefined) {
    body.kind = patch.kind;
  }
  if (patch.baseUrl !== undefined && patch.baseUrl !== "") {
    body.baseUrl = patch.baseUrl;
  }
  if (patch.model !== undefined) {
    body.model = patch.model;
  }
  // Empty apiKey on edit means "unchanged"; only send a new key.
  if (patch.apiKey !== undefined && patch.apiKey !== "") {
    body.apiKey = patch.apiKey;
  }
  // Empty timeout text resets to the server default (null).
  if (patch.ttftTimeoutMs !== undefined) {
    body.ttftTimeoutMs = parseTimeoutMs(patch.ttftTimeoutMs);
  }
  if (patch.totalTimeoutMs !== undefined) {
    body.totalTimeoutMs = parseTimeoutMs(patch.totalTimeoutMs);
  }
  // Empty headers text clears the stored headers (null).
  if (patch.customHeaders !== undefined) {
    body.customHeaders = parseCustomHeaders(patch.customHeaders);
  }
  return request(`/api/providers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteProvider(id: string): Promise<{ ok: boolean }> {
  return request(`/api/providers/${id}`, { method: "DELETE" });
}

export function testProvider(id: string): Promise<{ ok: boolean; model?: string; error?: string }> {
  return post(`/api/providers/${id}/test`);
}

export function setDefaultProvider(id: string): Promise<{ provider: Provider }> {
  return post(`/api/providers/${id}/default`);
}
