// Provider data access shared by the provider routes and the
// generation pipeline: row lookup, live-provider construction,
// per-turn resolution, SSRF gating, header validation, and the
// model-listing cache.

import { and, eq } from "drizzle-orm";
import type { AppDb, AppEnv } from "../app";
import { decryptSecret } from "../crypto";
import { isProviderKind, type LLMProvider, type ProviderConfigInput } from "../llm";
import { isOllamaCloud } from "../llm/ollama-provider";
import { SsrfError, assertPublicUrl } from "../llm/ssrf";
import { providerConfigs } from "../db/schema";
import type { ProviderRow } from "../routes/mappers";

export interface ProviderDeps {
  db: AppDb;
  sessionSecret: string;
  buildProvider: (config: ProviderConfigInput) => LLMProvider;
}

// The raw custom headers are never returned — only whether any are
// stored. Timeouts read back nullable (null = server defaults).
export function toProviderPublic(row: ProviderRow, hasKey: boolean) {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    hasKey,
    isDefault: row.isDefault === 1,
    createdAt: row.createdAt,
    hasCustomHeaders: row.customHeaders != null,
    ttftTimeoutMs: row.ttftTimeoutMs,
    totalTimeoutMs: row.totalTimeoutMs,
  };
}

export async function hasStoredKey(sessionSecret: string, row: ProviderRow): Promise<boolean> {
  try {
    return (await decryptSecret(sessionSecret, row.apiKeyEnc)) !== "";
  } catch {
    // Undecryptable (e.g. rotated SESSION_SECRET) reads as keyless
    // rather than failing the whole list.
    return false;
  }
}

export async function ownedProvider(db: AppDb, userId: string, id: string) {
  const rows = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// Builds a live provider from an owned row. Returns { status, ... }
// for JSON errors, or { provider, ttftTimeoutMs, totalTimeoutMs }
// on success (timeouts ride along so turns enforce the row's values).
export async function liveProvider(
  deps: ProviderDeps,
  userId: string,
  providerId: string | undefined,
): Promise<
  | { provider: LLMProvider; ttftTimeoutMs: number | null; totalTimeoutMs: number | null }
  | { status: 400 | 404 | 500; code: string; message: string }
> {
  const { db, sessionSecret, buildProvider } = deps;
  let row: ProviderRow | null;
  if (providerId) {
    row = await ownedProvider(db, userId, providerId);
    if (!row) {
      return { status: 404, code: "not_found", message: "provider not found" };
    }
  } else {
    const rows = await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isDefault, 1)))
      .limit(1);
    row = rows[0] ?? null;
    if (!row) {
      return { status: 400, code: "no_provider", message: "no default provider configured" };
    }
  }
  let apiKey: string;
  try {
    apiKey = await decryptSecret(sessionSecret, row.apiKeyEnc);
  } catch {
    return {
      status: 500,
      code: "key_unavailable",
      message: "stored provider key cannot be decrypted",
    };
  }
  if (!isProviderKind(row.kind)) {
    return { status: 500, code: "internal_error", message: "unknown provider kind" };
  }
  try {
    return {
      provider: buildProvider({
        kind: row.kind,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey,
        customHeaders: parseStoredHeaders(row.customHeaders),
      }),
      ttftTimeoutMs: row.ttftTimeoutMs,
      totalTimeoutMs: row.totalTimeoutMs,
    };
  } catch (err) {
    return {
      status: 500,
      code: "internal_error",
      message: err instanceof Error ? err.message : "cannot build provider",
    };
  }
}

// Resolves the provider for a turn: one-off body override first,
// then the story's persistent override, then the user's default.
// Retry resolves the same way (no per-action provider is stored) —
// a story with an override retries on the override, otherwise on
// the current default. A dangling story override (possible only on
// drivers without FK enforcement) falls back to the default.
export async function resolveStoryProvider(
  deps: ProviderDeps,
  userId: string,
  story: { providerId: string | null },
  bodyProviderId: string | undefined,
) {
  if (bodyProviderId) {
    return liveProvider(deps, userId, bodyProviderId);
  }
  if (story.providerId) {
    const resolved = await liveProvider(deps, userId, story.providerId);
    if (!("status" in resolved)) {
      return resolved;
    }
    if (resolved.status === 404) {
      return liveProvider(deps, userId, undefined);
    }
    return resolved;
  }
  return liveProvider(deps, userId, undefined);
}

// SSRF gate for user-controlled baseUrls: rejected before anything
// is stored or fetched.
export async function checkProviderUrl(
  env: AppEnv,
  baseUrl: string | undefined,
  kind?: string,
): Promise<string | null> {
  if (!baseUrl) {
    return null;
  }
  if (kind === "ollama" && isOllamaCloud(baseUrl)) {
    return null;
  }
  try {
    await assertPublicUrl(baseUrl, {
      allowPrivate: env.allowPrivateProviderUrls,
      allowLocalDefaults: kind === "ollama",
    });
    return null;
  } catch (err) {
    if (err instanceof SsrfError) {
      return err.message;
    }
    throw err;
  }
}

// Custom-headers validation (openai-compatible only honors them, but
// every kind validates on write so a kind switch cannot smuggle bad
// headers in). Keys: ASCII alphanumerics + dash, max 40 chars. Values:
// strings, max 4 KB each. Total JSON: max 8 KB. Reserved names —
// transport/auth/cookie headers that must never be overridden — are
// rejected case-insensitively.
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "authorization",
  "api-key",
  "x-api-key",
  "cookie",
]);

export function validateCustomHeaders(value: unknown): {
  headers?: Record<string, string>;
  error?: string;
} {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "customHeaders: must be a JSON object" };
  }
  const encoder = new TextEncoder();
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || key.length > 40) {
      return { error: `customHeaders: invalid header name "${key}"` };
    }
    if (RESERVED_HEADERS.has(key.toLowerCase())) {
      return { error: `customHeaders: header "${key}" is reserved` };
    }
    if (typeof val !== "string") {
      return { error: `customHeaders: value for "${key}" must be a string` };
    }
    if (encoder.encode(val).length > 4096) {
      return { error: `customHeaders: value for "${key}" exceeds 4 KB` };
    }
    headers[key] = val;
  }
  if (encoder.encode(JSON.stringify(headers)).length > 8192) {
    return { error: "customHeaders: total size exceeds 8 KB" };
  }
  return { headers };
}

// Stored custom_headers JSON is validated on write, but a row written
// by an older build (or hand-edited) must never break a turn: parse
// defensively and drop non-string values.
export function parseStoredHeaders(raw: string | null): Record<string, string> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val === "string") {
        out[key] = val;
      }
    }
    return out;
  } catch {
    return null;
  }
}

// Model-listing cache: per provider id, 5 minutes, invalidated on PATCH
// (and DELETE). The response body is never logged — ids only.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
interface ModelsCacheEntry {
  models: string[];
  source: "listing" | "fallback";
  expiresAt: number;
}
const modelsCache = new Map<string, ModelsCacheEntry>();

export function getCachedModels(
  id: string,
): { models: string[]; source: "listing" | "fallback" } | null {
  const cached = modelsCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { models: cached.models, source: cached.source };
  }
  return null;
}

export function setCachedModels(
  id: string,
  entry: { models: string[]; source: "listing" | "fallback" },
): void {
  modelsCache.set(id, { ...entry, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
}

export function invalidateModelsCache(id: string): void {
  modelsCache.delete(id);
}
