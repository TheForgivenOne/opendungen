// Story data access shared by route groups: live-story lookup and
// the explicit-column action projection used on the hot paths.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDb } from "../app";
import { stories } from "../db/schema";

// A live story: exists, owned by the caller, not soft-deleted.
export async function liveStory(db: AppDb, userId: string, id: string) {
  const rows = await db
    .select()
    .from(stories)
    .where(and(eq(stories.id, id), eq(stories.userId, userId), isNull(stories.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

// Explicit-column projection for the actions hot paths (list +
// export). Every other table still selects full rows via the query
// builder: the WorkerDb/LocalDb union breaks select-with-args
// overloads (see PROGRESS.md).
export interface ActionProjection {
  id: string;
  story_id: string;
  idx: number;
  type: string;
  text: string;
  mode: string | null;
  created_at: number;
}

export async function listStoryActionViews(db: AppDb, storyId: string) {
  const rows = await db.all<ActionProjection>(
    sql`select id, story_id, idx, type, text, mode, created_at from actions where story_id = ${storyId} order by idx`,
  );
  return rows.map((r) => ({
    id: r.id,
    storyId: r.story_id,
    idx: r.idx,
    type: r.type,
    text: r.text,
    mode: r.mode,
    createdAt: r.created_at,
  }));
}
