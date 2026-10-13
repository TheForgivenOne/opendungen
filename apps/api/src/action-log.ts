// Shared action-log writes. Both the manual append endpoint and the
// generation pipeline assign idx as max+1 with retry on unique-conflict
// races, so the log stays gapless per story under concurrency.

import { desc, eq } from "drizzle-orm";
import type { AppDb } from "./app";
import { actions } from "./db/schema";

export type ActionType = "input" | "output" | "continue";

export interface ActionRow {
  id: string;
  storyId: string;
  idx: number;
  type: string;
  text: string;
  // Player input mode ('do' | 'say' | 'story'); null = AI output.
  mode: string | null;
  createdAt: number;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

// Highest idx in the story, or -1 when the log is empty.
export async function maxActionIdx(db: AppDb, storyId: string): Promise<number> {
  const top = await db
    .select()
    .from(actions)
    .where(eq(actions.storyId, storyId))
    .orderBy(desc(actions.idx))
    .limit(1);
  return top[0]?.idx ?? -1;
}

// Appends at max+1, retrying on unique-conflict races.
export async function appendAction(
  db: AppDb,
  storyId: string,
  type: ActionType,
  text: string,
  mode?: string | null,
): Promise<ActionRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const idx = (await maxActionIdx(db, storyId)) + 1;
    const row: ActionRow = {
      id: crypto.randomUUID(),
      storyId,
      idx,
      type,
      text,
      mode: mode ?? null,
      createdAt: Date.now(),
    };
    try {
      await db.insert(actions).values(row);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 4) {
        throw err;
      }
      continue;
    }
    return row;
  }
  throw new Error("failed to assign action idx");
}

// Inserts at an exact idx (used for a turn's output at inputIdx + 1).
// On conflict, falls back to max+1 so the write never fails spuriously.
export async function insertActionAtIdx(
  db: AppDb,
  storyId: string,
  idx: number,
  type: ActionType,
  text: string,
): Promise<ActionRow> {
  const row: ActionRow = {
    id: crypto.randomUUID(),
    storyId,
    idx,
    type,
    text,
    // Exact-idx inserts are AI outputs (retry/continue persistence).
    mode: null,
    createdAt: Date.now(),
  };
  try {
    await db.insert(actions).values(row);
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    return appendAction(db, storyId, type, text);
  }
}

export async function deleteActionsByIds(db: AppDb, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.delete(actions).where(eq(actions.id, id));
  }
}

// Ordered log for one story (oldest first). Scoping to the story id is the
// caller's job via liveStory; this helper only orders.
export async function listStoryActions(db: AppDb, storyId: string): Promise<ActionRow[]> {
  const rows = await db
    .select()
    .from(actions)
    .where(eq(actions.storyId, storyId))
    .orderBy(actions.idx);
  return rows.map((row) => ({
    id: row.id,
    storyId: row.storyId,
    idx: row.idx,
    type: row.type,
    text: row.text,
    mode: row.mode,
    createdAt: row.createdAt,
  }));
}
