// Action-log routes: list (explicit-column projection) and append.
// Undo (delete last pair) and edit live here too — they mutate the log.
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { appendAction, deleteActionsByIds, listStoryActions } from "../action-log";
import { actions, stories } from "../db/schema";
import { applyInputMode } from "../input-mode";
import { listStoryActionViews, liveStory } from "../services/stories";
import { apiError } from "./http";
import { toAction } from "./mappers";
import { appendActionSchema, invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

export function registerActions(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  const editActionSchema = z.object({
    text: z.string().min(1).max(50000),
  });

  // Hot-path reads of the action log use explicit column lists rather
  // than full-row selects. Column-list select() does NOT typecheck on
  // the WorkerDb/LocalDb union (only the no-args overload is shared),
  // so this uses raw SQL via db.all() — exposed with identical
  // signatures on both drivers — and maps to typed objects manually.

  app.get("/api/stories/:id/actions", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    return c.json({ actions: await listStoryActionViews(db, row.id) });
  });

  app.post(
    "/api/stories/:id/actions",
    requireAuth,
    zValidator("json", appendActionSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const body = c.req.valid("json");
      // Mode defaults to story when omitted; the text transform is
      // idempotent so a pre-transformed client send is unchanged.
      const mode = body.mode ?? "story";
      // Idx is server-assigned (max + 1); the shared helper retries on
      // unique-conflict races between concurrent appends.
      const actionRow = await appendAction(
        db,
        row.id,
        body.type,
        applyInputMode(body.text, mode),
        mode,
      );
      await db.update(stories).set({ updatedAt: Date.now() }).where(eq(stories.id, row.id));
      return c.json({ action: toAction(actionRow) }, 201);
    },
  );

  app.post("/api/stories/:id/undo", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const ordered = await listStoryActions(db, row.id);
    const last = ordered[ordered.length - 1];
    if (!last) {
      return c.json(apiError("nothing_to_undo", "no actions to undo"), 409);
    }
    // The last input+output pair, or a lone trailing input when a
    // generation was aborted or errored before producing output.
    const prev = ordered[ordered.length - 2];
    const ids = last.type !== "input" && prev?.type === "input" ? [prev.id, last.id] : [last.id];
    await deleteActionsByIds(db, ids);
    await db.update(stories).set({ updatedAt: Date.now() }).where(eq(stories.id, row.id));
    return c.json({ deleted: ids.length });
  });

  app.patch(
    "/api/stories/:id/actions/:actionId",
    requireAuth,
    zValidator("json", editActionSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const found = await db
        .select()
        .from(actions)
        .where(and(eq(actions.id, c.req.param("actionId")), eq(actions.storyId, row.id)))
        .limit(1);
      const action = found[0];
      if (!action) {
        return c.json(apiError("not_found", "action not found"), 404);
      }
      const body = c.req.valid("json");
      await db.update(actions).set({ text: body.text }).where(eq(actions.id, action.id));
      return c.json({ action: toAction({ ...action, text: body.text }) });
    },
  );
}
