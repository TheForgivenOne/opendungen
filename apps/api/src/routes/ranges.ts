// Compressed-range routes: list per story plus delete (children
// are unlinked, never cascade-deleted).
import { eq } from "drizzle-orm";
import { compressedRanges } from "../db/schema";
import { listStoryActions } from "../action-log";
import { liveStory } from "../services/stories";
import { apiError } from "./http";
import { toRange } from "./mappers";
import type { AppRouter, RouteCtx } from "./types";

export function registerRanges(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  app.get("/api/stories/:id/ranges", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const rows = await db
      .select()
      .from(compressedRanges)
      .where(eq(compressedRanges.storyId, row.id))
      .orderBy(compressedRanges.startIdx);
    const ordered = await listStoryActions(db, row.id);
    return c.json({ ranges: rows.map((r) => toRange(r, ordered)) });
  });

  app.delete("/api/ranges/:rangeId", requireAuth, async (c) => {
    const user = currentUser(c);
    const found = await db
      .select()
      .from(compressedRanges)
      .where(eq(compressedRanges.id, c.req.param("rangeId")))
      .limit(1);
    const range = found[0];
    if (!range) {
      return c.json(apiError("not_found", "range not found"), 404);
    }
    const story = await liveStory(db, user.id, range.storyId);
    if (!story) {
      return c.json(apiError("not_found", "range not found"), 404);
    }
    // Children are NOT deleted with the parent — only unlinked, so
    // ranges the parent had suppressed re-surface per the assembly
    // nesting rules. (Unlinking, rather than leaving a dangling
    // parent_range_id, keeps the delete working on drivers that enforce
    // the self-referencing foreign key.) The covered actions were never
    // touched and become visible again immediately.
    await db
      .update(compressedRanges)
      .set({ parentRangeId: null })
      .where(eq(compressedRanges.parentRangeId, range.id));
    await db.delete(compressedRanges).where(eq(compressedRanges.id, range.id));
    return c.json({ ok: true });
  });
}
