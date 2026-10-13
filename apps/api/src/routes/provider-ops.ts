// Provider operations: model listing (cached), connection testing,
// and default selection.
import { eq } from "drizzle-orm";
import { decryptSecret } from "../crypto";
import { providerConfigs } from "../db/schema";
import { ProviderError, isProviderKind, type LLMProvider } from "../llm";
import {
  checkProviderUrl,
  getCachedModels,
  hasStoredKey,
  ownedProvider,
  parseStoredHeaders,
  setCachedModels,
  toProviderPublic,
} from "../services/providers";
import { apiError } from "./http";
import type { AppRouter, RouteCtx } from "./types";

export function registerProviderOps(app: AppRouter, ctx: RouteCtx) {
  const { buildProvider, currentUser, db, env, requireAuth, sessionSecret } = ctx;

  // Model listing for the provider form's datalist. Cached per
  // provider id for 5 minutes; PATCH/DELETE invalidate. The response
  // body is never logged — ids flow straight back to the caller.
  app.get("/api/providers/:id/models", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await ownedProvider(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "provider not found"), 404);
    }
    const cached = getCachedModels(row.id);
    if (cached) {
      return c.json({ models: cached.models, source: cached.source });
    }
    // SSRF gate before any fetch (listing fetches server-side).
    if (row.baseUrl && (row.kind === "ollama" || row.kind === "openai-compatible")) {
      const ssrf = await checkProviderUrl(env, row.baseUrl, row.kind);
      if (ssrf) {
        return c.json(apiError("validation_error", `baseUrl: ${ssrf}`), 400);
      }
    }
    let apiKey: string;
    try {
      apiKey = await decryptSecret(sessionSecret, row.apiKeyEnc);
    } catch {
      return c.json(apiError("key_unavailable", "stored provider key cannot be decrypted"), 500);
    }
    if (!isProviderKind(row.kind)) {
      return c.json(apiError("internal_error", `unknown provider kind: ${row.kind}`), 500);
    }
    let provider: LLMProvider;
    try {
      provider = buildProvider({
        kind: row.kind,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey,
        customHeaders: parseStoredHeaders(row.customHeaders),
      });
    } catch (err) {
      return c.json(
        apiError("internal_error", err instanceof Error ? err.message : "cannot build provider"),
        500,
      );
    }
    try {
      const listing = await provider.listModels();
      setCachedModels(row.id, {
        models: listing.models,
        source: listing.source,
      });
      return c.json({ models: listing.models, source: listing.source });
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : "model listing failed";
      return c.json(apiError("listing_failed", message), 502);
    }
  });

  app.post("/api/providers/:id/test", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await ownedProvider(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "provider not found"), 404);
    }
    // SSRF check before any fetch (testConnection fetches server-side).
    if (row.baseUrl) {
      const ssrf = await checkProviderUrl(env, row.baseUrl, row.kind);
      if (ssrf) {
        return c.json({ ok: false, error: ssrf });
      }
    }
    let apiKey: string;
    try {
      apiKey = await decryptSecret(sessionSecret, row.apiKeyEnc);
    } catch {
      return c.json({
        ok: false,
        error: "stored key cannot be decrypted (was SESSION_SECRET rotated?)",
      });
    }
    if (!isProviderKind(row.kind)) {
      return c.json({ ok: false, error: `unknown provider kind: ${row.kind}` });
    }
    try {
      const provider = buildProvider({
        kind: row.kind,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey,
        customHeaders: parseStoredHeaders(row.customHeaders),
      });
      return c.json(await provider.testConnection());
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "test failed" });
    }
  });

  app.post("/api/providers/:id/default", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await ownedProvider(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "provider not found"), 404);
    }
    await db
      .update(providerConfigs)
      .set({ isDefault: 0 })
      .where(eq(providerConfigs.userId, user.id));
    await db.update(providerConfigs).set({ isDefault: 1 }).where(eq(providerConfigs.id, row.id));
    return c.json({
      provider: toProviderPublic({ ...row, isDefault: 1 }, await hasStoredKey(sessionSecret, row)),
    });
  });
}
