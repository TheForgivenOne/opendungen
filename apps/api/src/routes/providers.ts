// Provider-config routes: CRUD plus key handling. Stored keys are
// AES-GCM encrypted; api_key_enc never leaves the server.
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { encryptSecret } from "../crypto";
import { providerConfigs } from "../db/schema";
import { isProviderKind } from "../llm";
import { isOllamaCloud } from "../llm/ollama-provider";
import {
  checkProviderUrl,
  hasStoredKey,
  invalidateModelsCache,
  ownedProvider,
  toProviderPublic,
  validateCustomHeaders,
} from "../services/providers";
import { apiError } from "./http";
import { invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

export function registerProviders(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, env, requireAuth, sessionSecret } = ctx;

  const providerKindSchema = z.enum(["openai", "anthropic", "ollama", "openai-compatible"]);
  const baseUrlSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((v) => /^https?:\/\/[^\s]+$/.test(v), {
      message: "baseUrl must be an http(s) URL",
    });

  function providerNeedsBaseUrl(kind: string): boolean {
    return kind === "ollama" || kind === "openai-compatible";
  }

  // Per-provider timeouts: nullable (null = 60s TTFT / 180s total
  // defaults), validated to 1000–600000 ms on write.
  const timeoutMsSchema = z.number().int().min(1000).max(600000).nullable().optional();
  // Custom headers arrive as a JSON object (validated semantically in
  // the handler); null clears. Only openai-compatible sends them.
  const customHeadersSchema = z.unknown().nullable().optional();

  const createProviderSchema = z
    .object({
      // Empty labels are accepted by the schema so the handler can
      // answer provider_label_required (not a generic validation
      // error); whitespace-only labels are rejected the same way.
      label: z.string().max(200),
      kind: providerKindSchema,
      baseUrl: baseUrlSchema.optional(),
      model: z.string().min(1).max(200),
      // Optional so keyless local providers (Ollama) need no dummy key.
      apiKey: z.string().max(2000).optional(),
      ttftTimeoutMs: timeoutMsSchema,
      totalTimeoutMs: timeoutMsSchema,
      customHeaders: customHeadersSchema,
    })
    .refine((data) => !providerNeedsBaseUrl(data.kind) || !!data.baseUrl, {
      message: "baseUrl is required for this provider kind",
      path: ["baseUrl"],
    });

  const patchProviderSchema = z
    .object({
      label: z.string().max(200).optional(),
      kind: providerKindSchema.optional(),
      baseUrl: baseUrlSchema.optional(),
      model: z.string().min(1).max(200).optional(),
      // Omitted = unchanged. (isDefault is not patchable; use /default.)
      apiKey: z.string().max(2000).optional(),
      ttftTimeoutMs: timeoutMsSchema,
      totalTimeoutMs: timeoutMsSchema,
      customHeaders: customHeadersSchema,
    })
    .refine((o) => Object.keys(o).length > 0, {
      message: "at least one field is required",
    });

  // Builds a live provider from an owned row. Returns { status, ... }
  // for JSON errors, or { provider, ttftTimeoutMs, totalTimeoutMs }
  // on success (timeouts ride along so turns enforce the row's values).

  app.get("/api/providers", requireAuth, async (c) => {
    const user = currentUser(c);
    const rows = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.userId, user.id))
      .orderBy(providerConfigs.createdAt);
    const providers = await Promise.all(
      rows.map(async (row) => toProviderPublic(row, await hasStoredKey(sessionSecret, row))),
    );
    return c.json({ providers });
  });

  app.post(
    "/api/providers",
    requireAuth,
    zValidator("json", createProviderSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const body = c.req.valid("json");
      // The label is required and never defaults to the model name:
      // empty labels would make same-model providers indistinguishable.
      if (!body.label.trim()) {
        return c.json(apiError("provider_label_required", "label is required"), 400);
      }
      const ssrf = await checkProviderUrl(env, body.baseUrl, body.kind);
      if (ssrf) {
        return c.json(apiError("validation_error", `baseUrl: ${ssrf}`), 400);
      }
      // Ollama Cloud requires an API key; a local server does not.
      if (body.kind === "ollama" && isOllamaCloud(body.baseUrl) && !body.apiKey) {
        return c.json(
          apiError("ollama_cloud_key_required", "an API key is required for Ollama Cloud"),
          400,
        );
      }
      const checked = validateCustomHeaders(body.customHeaders);
      if (checked.error) {
        return c.json(apiError("validation_error", checked.error), 400);
      }
      const now = Date.now();
      const row = {
        id: crypto.randomUUID(),
        userId: user.id,
        label: body.label,
        kind: body.kind,
        baseUrl: body.baseUrl ?? null,
        model: body.model,
        apiKeyEnc: await encryptSecret(sessionSecret, body.apiKey ?? ""),
        isDefault: 0,
        createdAt: now,
        ttftTimeoutMs: body.ttftTimeoutMs ?? null,
        totalTimeoutMs: body.totalTimeoutMs ?? null,
        // An empty object stores as null (no headers to send).
        customHeaders:
          checked.headers && Object.keys(checked.headers).length > 0
            ? JSON.stringify(checked.headers)
            : null,
      };
      await db.insert(providerConfigs).values(row);
      return c.json({ provider: toProviderPublic(row, (body.apiKey ?? "") !== "") }, 201);
    },
  );

  app.patch(
    "/api/providers/:id",
    requireAuth,
    zValidator("json", patchProviderSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await ownedProvider(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "provider not found"), 404);
      }
      const body = c.req.valid("json");
      if (body.label !== undefined && !body.label.trim()) {
        return c.json(apiError("provider_label_required", "label is required"), 400);
      }
      // Validate the merged row so kind/baseUrl/model stay consistent.
      const merged = {
        kind: body.kind ?? row.kind,
        baseUrl: body.baseUrl ?? row.baseUrl ?? undefined,
        model: body.model ?? row.model,
      };
      if (!isProviderKind(merged.kind)) {
        return c.json(apiError("validation_error", "kind: invalid provider kind"), 400);
      }
      if (providerNeedsBaseUrl(merged.kind) && !merged.baseUrl) {
        return c.json(
          apiError("validation_error", "baseUrl: baseUrl is required for this provider kind"),
          400,
        );
      }
      if (!merged.model) {
        return c.json(apiError("validation_error", "model: model is required"), 400);
      }
      // The merged endpoint must still satisfy the cloud-key rule:
      // pointing an ollama row at ollama.com without any key — stored
      // or in this PATCH — is rejected.
      if (merged.kind === "ollama" && isOllamaCloud(merged.baseUrl)) {
        const hasKey =
          body.apiKey !== undefined ? body.apiKey !== "" : await hasStoredKey(sessionSecret, row);
        if (!hasKey) {
          return c.json(
            apiError("ollama_cloud_key_required", "an API key is required for Ollama Cloud"),
            400,
          );
        }
      }
      // Re-check only when baseUrl itself changes.
      if (body.baseUrl !== undefined) {
        const ssrf = await checkProviderUrl(env, body.baseUrl, merged.kind);
        if (ssrf) {
          return c.json(apiError("validation_error", `baseUrl: ${ssrf}`), 400);
        }
      }
      // Custom headers validate on PATCH exactly like on create;
      // null (or an empty object) clears back to no headers.
      let customHeaders: string | null | undefined;
      if (body.customHeaders !== undefined) {
        const checked = validateCustomHeaders(body.customHeaders);
        if (checked.error) {
          return c.json(apiError("validation_error", checked.error), 400);
        }
        customHeaders =
          checked.headers && Object.keys(checked.headers).length > 0
            ? JSON.stringify(checked.headers)
            : null;
      }
      const patch: {
        label?: string;
        kind?: string;
        baseUrl?: string | null;
        model?: string;
        apiKeyEnc?: string;
        ttftTimeoutMs?: number | null;
        totalTimeoutMs?: number | null;
        customHeaders?: string | null;
      } = {};
      if (body.label !== undefined) {
        patch.label = body.label;
      }
      if (body.kind !== undefined) {
        patch.kind = body.kind;
      }
      if (body.baseUrl !== undefined) {
        patch.baseUrl = body.baseUrl;
      }
      if (body.model !== undefined) {
        patch.model = body.model;
      }
      if (body.ttftTimeoutMs !== undefined) {
        patch.ttftTimeoutMs = body.ttftTimeoutMs;
      }
      if (body.totalTimeoutMs !== undefined) {
        patch.totalTimeoutMs = body.totalTimeoutMs;
      }
      if (customHeaders !== undefined) {
        patch.customHeaders = customHeaders;
      }
      let hasKey = await hasStoredKey(sessionSecret, row);
      if (body.apiKey !== undefined) {
        patch.apiKeyEnc = await encryptSecret(sessionSecret, body.apiKey);
        hasKey = body.apiKey !== "";
      }
      await db.update(providerConfigs).set(patch).where(eq(providerConfigs.id, row.id));
      // Model listings cache per provider id; any PATCH may change
      // what the listing returns, so the entry is dropped.
      invalidateModelsCache(row.id);
      return c.json({ provider: toProviderPublic({ ...row, ...patch }, hasKey) });
    },
  );

  app.delete("/api/providers/:id", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await ownedProvider(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "provider not found"), 404);
    }
    await db.delete(providerConfigs).where(eq(providerConfigs.id, row.id));
    invalidateModelsCache(row.id);
    return c.json({ ok: true });
  });
}
