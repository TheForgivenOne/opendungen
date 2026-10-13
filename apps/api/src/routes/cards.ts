// Story-card routes: basic CRUD scoped to the owning story.
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { storyCards } from "../db/schema";
import { liveStory } from "../services/stories";
import { apiError } from "./http";
import { toCard } from "./mappers";
import { createCardSchema, invalidRequest, patchCardSchema } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

export function registerCards(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  app.get("/api/stories/:id/cards", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const rows = await db.select().from(storyCards).where(eq(storyCards.storyId, row.id));
    return c.json({ cards: rows.map(toCard) });
  });

  app.post(
    "/api/stories/:id/cards",
    requireAuth,
    zValidator("json", createCardSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const body = c.req.valid("json");
      const cardRow = {
        id: crypto.randomUUID(),
        storyId: row.id,
        keys: JSON.stringify(body.keys),
        entry: body.entry,
        enabled: (body.enabled ?? true) ? 1 : 0,
      };
      await db.insert(storyCards).values(cardRow);
      return c.json({ card: toCard(cardRow) }, 201);
    },
  );

  app.patch(
    "/api/stories/:id/cards/:cardId",
    requireAuth,
    zValidator("json", patchCardSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const cardRows = await db
        .select()
        .from(storyCards)
        .where(and(eq(storyCards.id, c.req.param("cardId")), eq(storyCards.storyId, row.id)))
        .limit(1);
      const card = cardRows[0];
      if (!card) {
        return c.json(apiError("not_found", "card not found"), 404);
      }
      const body = c.req.valid("json");
      const patch: { keys?: string; entry?: string; enabled?: number } = {};
      if (body.keys !== undefined) {
        patch.keys = JSON.stringify(body.keys);
      }
      if (body.entry !== undefined) {
        patch.entry = body.entry;
      }
      if (body.enabled !== undefined) {
        patch.enabled = body.enabled ? 1 : 0;
      }
      await db.update(storyCards).set(patch).where(eq(storyCards.id, card.id));
      return c.json({ card: toCard({ ...card, ...patch }) });
    },
  );

  app.delete("/api/stories/:id/cards/:cardId", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    await db
      .delete(storyCards)
      .where(and(eq(storyCards.id, c.req.param("cardId")), eq(storyCards.storyId, row.id)));
    return c.json({ ok: true });
  });
}
