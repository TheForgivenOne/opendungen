import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { scriptStates, scripts } from "../db/schema";
import { loadScriptStates, saveScriptStates } from "./state";
import { createStoryRows, createTestApp } from "../testing";

async function seedScripts(db: ReturnType<typeof createTestApp>["db"], storyId: string) {
  const now = Date.now();
  for (const id of ["script-a", "script-b", "broken"]) {
    await db.insert(scripts).values({
      id,
      storyId,
      scenarioId: null,
      name: id,
      source: "text;",
      enabled: 1,
      position: 0,
      createdAt: now,
    });
  }
}

describe("script state persistence", () => {
  it("round-trips states through the DB", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScripts(db, storyId);

    expect(await loadScriptStates(db, storyId)).toEqual(new Map());

    await saveScriptStates(
      db,
      storyId,
      new Map([
        ["script-a", '{"n":1}'],
        ["script-b", '{"tags":["x"]}'],
      ]),
    );
    expect(await loadScriptStates(db, storyId)).toEqual(
      new Map([
        ["script-a", { n: 1 }],
        ["script-b", { tags: ["x"] }],
      ]),
    );

    // Updates overwrite; untouched rows survive.
    await saveScriptStates(db, storyId, new Map([["script-a", '{"n":2}']]));
    expect(await loadScriptStates(db, storyId)).toEqual(
      new Map([
        ["script-a", { n: 2 }],
        ["script-b", { tags: ["x"] }],
      ]),
    );
  });

  it("reads corrupt rows as empty objects", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await seedScripts(db, storyId);
    await db.insert(scriptStates).values({
      scriptId: "broken",
      storyId,
      state: "{not json",
      updatedAt: Date.now(),
    });
    expect(await loadScriptStates(db, storyId)).toEqual(new Map([["broken", {}]]));
  });

  it("saving nothing writes nothing", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    await saveScriptStates(db, storyId, new Map());
    const rows = await db.select().from(scriptStates).where(eq(scriptStates.storyId, storyId));
    expect(rows).toHaveLength(0);
  });
});
