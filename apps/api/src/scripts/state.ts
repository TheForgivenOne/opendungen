// Script state persistence: per-script, per-story JSON blobs in
// script_states. runHook reports changed states; these helpers load
// them before a turn and upsert them after each hook.

import { eq } from "drizzle-orm";
import type { AppDb } from "../app";
import { scriptStates } from "../db/schema";

// Loads parsed states for one story. Corrupt rows read as {} rather
// than failing the turn.
export async function loadScriptStates(db: AppDb, storyId: string): Promise<Map<string, unknown>> {
  const rows = await db.select().from(scriptStates).where(eq(scriptStates.storyId, storyId));
  const states = new Map<string, unknown>();
  for (const row of rows) {
    try {
      states.set(row.scriptId, JSON.parse(row.state) as unknown);
    } catch {
      states.set(row.scriptId, {});
    }
  }
  return states;
}

// Upserts serialized states reported by runHook. Values arrive
// pre-serialized and cap-checked; this only writes rows.
export async function saveScriptStates(
  db: AppDb,
  storyId: string,
  updates: Map<string, string>,
): Promise<void> {
  if (updates.size === 0) {
    return;
  }
  const now = Date.now();
  for (const [scriptId, state] of updates) {
    await db
      .insert(scriptStates)
      .values({ scriptId, storyId, state, updatedAt: now })
      .onConflictDoUpdate({
        target: [scriptStates.scriptId, scriptStates.storyId],
        set: { state, updatedAt: now },
      });
  }
}
