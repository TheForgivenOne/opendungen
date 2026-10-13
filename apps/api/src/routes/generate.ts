// Generation routes: generate (incl. continue turns) and retry over
// SSE. Turn execution lives in services/generation.
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { deleteActionsByIds } from "../action-log";
import { applyInputMode, isInputMode } from "../input-mode";
import { resolveStoryProvider } from "../services/providers";
import { generationContext, streamTurn, unknownRestoreId } from "../services/generation";
import { apiError } from "./http";
import { invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

// Phase 6b: `continue: true` generates from context with no new
// input (Continue is a real generation, not a fake ellipsis input).
// The input text is required on normal turns, absent on continues.
const generateSchema = z
  .object({
    input: z.string().min(1).max(50000).optional(),
    providerId: z.string().min(1).max(128).optional(),
    restoreRangeIds: z.array(z.string().min(1).max(128)).max(100).optional(),
    mode: z.enum(["do", "say", "story"]).optional(),
    continue: z.boolean().optional(),
  })
  .refine((o) => o.continue === true || (o.input !== undefined && o.input.length > 0), {
    message: "input is required unless continue is true",
  });

// Retry accepts an optional JSON body (unlike generate it is often
// called bodyless, so the parse stays lenient). providerId is the
// same one-off override generate accepts.
const retryBodySchema = z.object({
  providerId: z.string().min(1).max(128).optional(),
  restoreRangeIds: z.array(z.string().min(1).max(128)).max(100).optional(),
});

export function registerGenerate(app: AppRouter, ctx: RouteCtx) {
  const { buildProvider, currentUser, db, env, requireAuth, sessionSecret } = ctx;

  app.post(
    "/api/stories/:id/generate",
    requireAuth,
    zValidator("json", generateSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const ctx = await generationContext(db, env, user.id, c.req.param("id"));
      if (!ctx) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const body = c.req.valid("json");
      const restoreRangeIds = body.restoreRangeIds ?? [];
      const unknown = unknownRestoreId(restoreRangeIds, ctx.ranges);
      if (unknown) {
        return c.json(
          apiError("validation_error", `restoreRangeIds: unknown range: ${unknown}`),
          400,
        );
      }
      const resolved = await resolveStoryProvider(
        { db, sessionSecret, buildProvider },
        user.id,
        ctx.story,
        body.providerId,
      );
      if ("status" in resolved) {
        return c.json(
          apiError(resolved.code, resolved.message),
          resolved.status as 400 | 404 | 500,
        );
      }
      // Continue turns generate output directly from the story
      // context: no input action, no input-hook, and only the output
      // action is persisted (see generateTurn skipInput).
      if (body.continue === true) {
        return streamTurn(
          c,
          { db, env },
          {
            storyId: ctx.story.id,
            story: ctx.story,
            actions: ctx.actions,
            cards: ctx.cards,
            skipInput: true,
            mode: "continue",
            provider: resolved.provider,
            signal: c.req.raw.signal,
            scripts: ctx.scripts,
            scriptStates: ctx.scriptStates,
            ranges: ctx.ranges,
            restoreRangeIds,
            ttftTimeoutMs: resolved.ttftTimeoutMs,
            totalTimeoutMs: resolved.totalTimeoutMs,
          },
        );
      }
      // Mode defaults to story when omitted (same rule as the
      // manual append endpoint); the transform is idempotent. The
      // turn mode drives the Layer 4 directive + input formatting.
      const inputMode = body.mode ?? "story";
      return streamTurn(
        c,
        { db, env },
        {
          storyId: ctx.story.id,
          story: ctx.story,
          actions: ctx.actions,
          cards: ctx.cards,
          userInput: applyInputMode(body.input ?? "", inputMode),
          inputMode,
          mode: inputMode,
          provider: resolved.provider,
          signal: c.req.raw.signal,
          scripts: ctx.scripts,
          scriptStates: ctx.scriptStates,
          ranges: ctx.ranges,
          restoreRangeIds,
          ttftTimeoutMs: resolved.ttftTimeoutMs,
          totalTimeoutMs: resolved.totalTimeoutMs,
        },
      );
    },
  );

  app.post("/api/stories/:id/retry", requireAuth, async (c) => {
    const user = currentUser(c);
    const ctx = await generationContext(db, env, user.id, c.req.param("id"));
    if (!ctx) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const last = ctx.actions[ctx.actions.length - 1];
    if (!last) {
      return c.json(apiError("cannot_retry", "the story is empty"), 409);
    }
    // Retry bodies are optional; an absent or empty body means no
    // restores and no one-off provider override.
    let restoreRangeIds: string[] = [];
    let bodyProviderId: string | undefined;
    const rawBody = await c.req.text();
    if (rawBody.trim()) {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
      const parsed = retryBodySchema.safeParse(parsedBody);
      if (!parsed.success) {
        return c.json(apiError("validation_error", "restoreRangeIds: invalid request body"), 400);
      }
      restoreRangeIds = parsed.data.restoreRangeIds ?? [];
      bodyProviderId = parsed.data.providerId;
    }
    const unknown = unknownRestoreId(restoreRangeIds, ctx.ranges);
    if (unknown) {
      return c.json(
        apiError("validation_error", `restoreRangeIds: unknown range: ${unknown}`),
        400,
      );
    }
    // The provider resolves exactly like a generate call (one-off >
    // story override > current default).
    const resolved = await resolveStoryProvider(
      { db, sessionSecret, buildProvider },
      user.id,
      ctx.story,
      bodyProviderId,
    );
    if ("status" in resolved) {
      return c.json(apiError(resolved.code, resolved.message), resolved.status as 400 | 404 | 500);
    }
    if (last.type === "input") {
      // Lone input (a turn that errored or aborted before producing
      // output): delete nothing — the output is generated for the
      // existing input action, reusing its stored mode.
      return streamTurn(
        c,
        { db, env },
        {
          storyId: ctx.story.id,
          story: ctx.story,
          actions: ctx.actions,
          cards: ctx.cards,
          userInput: last.text,
          mode: isInputMode(last.mode) ? last.mode : "story",
          provider: resolved.provider,
          signal: c.req.raw.signal,
          reuseInputActionId: last.id,
          scripts: ctx.scripts,
          scriptStates: ctx.scriptStates,
          ranges: ctx.ranges,
          restoreRangeIds,
          ttftTimeoutMs: resolved.ttftTimeoutMs,
          totalTimeoutMs: resolved.totalTimeoutMs,
        },
      );
    }
    if (last.type !== "output") {
      return c.json(apiError("cannot_retry", "the last action is not an output"), 409);
    }
    const prev = ctx.actions[ctx.actions.length - 2];
    if (!prev || prev.type !== "input") {
      // The output followed a continue (or the log starts with one):
      // delete it and regenerate from context with no input row.
      await deleteActionsByIds(db, [last.id]);
      return streamTurn(
        c,
        { db, env },
        {
          storyId: ctx.story.id,
          story: ctx.story,
          actions: ctx.actions.slice(0, -1),
          cards: ctx.cards,
          skipInput: true,
          mode: "continue",
          provider: resolved.provider,
          signal: c.req.raw.signal,
          scripts: ctx.scripts,
          scriptStates: ctx.scriptStates,
          ranges: ctx.ranges,
          restoreRangeIds,
          ttftTimeoutMs: resolved.ttftTimeoutMs,
          totalTimeoutMs: resolved.totalTimeoutMs,
        },
      );
    }
    // The old output is deleted before generation begins; retried
    // attempts leave no history.
    await deleteActionsByIds(db, [last.id]);
    return streamTurn(
      c,
      { db, env },
      {
        storyId: ctx.story.id,
        story: ctx.story,
        actions: ctx.actions.slice(0, -1),
        cards: ctx.cards,
        userInput: prev.text,
        mode: isInputMode(prev.mode) ? prev.mode : "story",
        provider: resolved.provider,
        signal: c.req.raw.signal,
        reuseInputActionId: prev.id,
        scripts: ctx.scripts,
        scriptStates: ctx.scriptStates,
        ranges: ctx.ranges,
        restoreRangeIds,
        ttftTimeoutMs: resolved.ttftTimeoutMs,
        totalTimeoutMs: resolved.totalTimeoutMs,
      },
    );
  });
}
