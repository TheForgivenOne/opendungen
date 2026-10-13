// Story routes: list, create, read, patch (incl. per-story
// provider/context overrides), soft-delete.
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { appendAction } from "../action-log";
import { scenarios, stories, storyCards } from "../db/schema";
import { ownedProvider } from "../services/providers";
import { liveStory } from "../services/stories";
import { apiError } from "./http";
import { toCard, toStory } from "./mappers";
import { createStorySchema, invalidRequest, patchStorySchema } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

export function registerStories(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  app.get("/api/stories", requireAuth, async (c) => {
    const user = currentUser(c);
    const rows = await db
      .select()
      .from(stories)
      .where(and(eq(stories.userId, user.id), isNull(stories.deletedAt)))
      .orderBy(desc(stories.updatedAt));
    return c.json({ stories: rows.map(toStory) });
  });

  app.post(
    "/api/stories",
    requireAuth,
    zValidator("json", createStorySchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const body = c.req.valid("json");
      let scenarioOpening: string | null = null;
      if (body.scenarioId) {
        const found = await db
          .select()
          .from(scenarios)
          .where(eq(scenarios.id, body.scenarioId))
          .limit(1);
        if (!found[0]) {
          return c.json(apiError("not_found", "scenario not found"), 404);
        }
        scenarioOpening = found[0].opening;
      }
      const now = Date.now();
      const row = {
        id: crypto.randomUUID(),
        userId: user.id,
        scenarioId: body.scenarioId ?? null,
        title: body.title,
        aiInstructions: "",
        plotEssentials: "",
        memory: "",
        summary: "",
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        providerId: null,
        compressTriggerPct: null,
        compressMaxTokens: null,
        compressTemperature: null,
        contextTokens: null,
        maxOutputTokens: null,
        completedAt: null,
      };
      await db.insert(stories).values(row);
      // The scenario's opening is the story's first output (idx 0): the
      // user reads it, then types their first action. No generation
      // fires on creation. Stories without a scenario start empty.
      if (scenarioOpening && scenarioOpening.trim() !== "") {
        await appendAction(db, row.id, "output", scenarioOpening);
      }
      return c.json({ story: toStory(row) }, 201);
    },
  );

  app.get("/api/stories/:id", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const cards = await db.select().from(storyCards).where(eq(storyCards.storyId, row.id));
    return c.json({ story: toStory(row), cards: cards.map(toCard) });
  });

  app.patch(
    "/api/stories/:id",
    requireAuth,
    zValidator("json", patchStorySchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const body = c.req.valid("json");
      // An override must point at a provider the caller owns; null
      // clears back to the default. Unknown ids are a 404.
      if (body.providerId) {
        const provider = await ownedProvider(db, user.id, body.providerId);
        if (!provider) {
          return c.json(apiError("not_found", "provider not found"), 404);
        }
      }
      const patch: {
        title?: string;
        aiInstructions?: string;
        plotEssentials?: string;
        memory?: string;
        providerId?: string | null;
        compressTriggerPct?: number | null;
        compressMaxTokens?: number | null;
        compressTemperature?: number | null;
        contextTokens?: number | null;
        maxOutputTokens?: number | null;
        completedAt?: number | null;
        updatedAt: number;
      } = { updatedAt: Date.now() };
      if (body.title !== undefined) {
        patch.title = body.title;
      }
      if (body.aiInstructions !== undefined) {
        patch.aiInstructions = body.aiInstructions;
      }
      if (body.plotEssentials !== undefined) {
        patch.plotEssentials = body.plotEssentials;
      }
      if (body.memory !== undefined) {
        patch.memory = body.memory;
      }
      if (body.providerId !== undefined) {
        patch.providerId = body.providerId;
      }
      if (body.compressTriggerPct !== undefined) {
        patch.compressTriggerPct = body.compressTriggerPct;
      }
      if (body.compressMaxTokens !== undefined) {
        patch.compressMaxTokens = body.compressMaxTokens;
      }
      if (body.compressTemperature !== undefined) {
        patch.compressTemperature = body.compressTemperature;
      }
      if (body.contextTokens !== undefined) {
        patch.contextTokens = body.contextTokens;
      }
      if (body.maxOutputTokens !== undefined) {
        patch.maxOutputTokens = body.maxOutputTokens;
      }
      if (body.completedAt !== undefined) {
        patch.completedAt = body.completedAt;
      }
      await db.update(stories).set(patch).where(eq(stories.id, row.id));
      return c.json({ story: toStory({ ...row, ...patch }) });
    },
  );

  app.delete("/api/stories/:id", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const now = Date.now();
    await db.update(stories).set({ deletedAt: now, updatedAt: now }).where(eq(stories.id, row.id));
    return c.json({ story: toStory({ ...row, deletedAt: now, updatedAt: now }) });
  });
}
