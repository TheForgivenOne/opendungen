// Export routes: versioned JSON backups (single-story + full).
// Provider keys are never exported, even with ?includeKeys=true.
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  compressedRanges,
  providerConfigs,
  scenarios,
  scriptStates,
  scripts,
  stories,
  storyCards,
} from "../db/schema";
import { listStoryActionViews, liveStory } from "../services/stories";
import { log } from "../log";
import { EXPORT_VERSION } from "../services/import";
import { apiError } from "./http";
import {
  toCard,
  toScript,
  toStory,
  type ProviderRow,
  type ScenarioRow,
  type StoryRow,
} from "./mappers";
import type { AppRouter, RouteCtx } from "./types";

export function registerExport(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  //   { opendungen: 1, exportedAt: <unix ms>,
  //     stories: [{ story, actions, cards, ranges, scripts, states }],
  //     scenarios: [...], providerConfigs: [...] }
  // scenarios holds full user-owned rows plus {id,title} refs for
  // referenced scenarios whose body is not exported (builtins, or a
  // single-story export). providerConfigs NEVER carry api_key_enc —
  // not even with ?includeKeys=true (warned + omitted); imports never
  // read keys either and always store an empty key for re-entry.

  type ScriptStateRow = { scriptId: string; storyId: string; state: string; updatedAt: number };

  async function exportStoryBundle(story: StoryRow) {
    const cardRows = await db.select().from(storyCards).where(eq(storyCards.storyId, story.id));
    const rangeRows = await db
      .select()
      .from(compressedRanges)
      .where(eq(compressedRanges.storyId, story.id))
      .orderBy(compressedRanges.startIdx);
    const scriptRows = await db
      .select()
      .from(scripts)
      .where(eq(scripts.storyId, story.id))
      .orderBy(scripts.position, scripts.id);
    const stateRows = await db
      .select()
      .from(scriptStates)
      .where(eq(scriptStates.storyId, story.id));
    return {
      story: toStory(story),
      actions: await listStoryActionViews(db, story.id),
      cards: cardRows.map(toCard),
      ranges: rangeRows.map((r) => ({
        id: r.id,
        storyId: r.storyId,
        startIdx: r.startIdx,
        endIdx: r.endIdx,
        summary: r.summary,
        parentRangeId: r.parentRangeId,
        createdAt: r.createdAt,
      })),
      scripts: scriptRows.map(toScript),
      states: stateRows.map((s): ScriptStateRow => ({
        scriptId: s.scriptId,
        storyId: s.storyId,
        state: s.state,
        updatedAt: s.updatedAt,
      })),
    };
  }

  function toExportProvider(row: ProviderRow) {
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.baseUrl,
      model: row.model,
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
    };
  }

  function toExportScenarioFull(row: ScenarioRow) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      opening: row.opening,
      aiInstructions: row.aiInstructions,
      tags: JSON.parse(row.tags) as string[],
    };
  }

  async function scenarioRefsFor(ids: (string | null)[]): Promise<{ id: string; title: string }[]> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const refs: { id: string; title: string }[] = [];
    for (const id of unique) {
      const found = await db.select().from(scenarios).where(eq(scenarios.id, id)).limit(1);
      if (found[0]) {
        refs.push({ id: found[0].id, title: found[0].title });
      }
    }
    return refs;
  }

  app.get("/api/export/story/:id", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const doc = {
      opendungen: EXPORT_VERSION,
      exportedAt: Date.now(),
      stories: [await exportStoryBundle(row)],
      scenarios: await scenarioRefsFor([row.scenarioId]),
      providerConfigs: [],
    };
    c.header("Content-Disposition", `attachment; filename="story-${row.id}.json"`);
    return c.json(doc);
  });

  app.get("/api/export/all", requireAuth, async (c) => {
    const user = currentUser(c);
    if (c.req.query("includeKeys") === "true") {
      // The flag exists for forward-compat, but keys are never
      // exported (see the Decisions section of PROGRESS.md).
      log.warn("export requested with ?includeKeys=true: provider keys are never exported", {
        requestId: c.get("requestId") as string | undefined,
      });
    }
    const liveStories = await db
      .select()
      .from(stories)
      .where(and(eq(stories.userId, user.id), isNull(stories.deletedAt)))
      .orderBy(desc(stories.updatedAt));
    const bundles = [];
    for (const story of liveStories) {
      bundles.push(await exportStoryBundle(story));
    }
    const ownedScenarioRows = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.userId, user.id));
    const ownedIds = new Set(ownedScenarioRows.map((r) => r.id));
    const refs = await scenarioRefsFor(
      liveStories.map((s) => s.scenarioId).filter((id) => id && !ownedIds.has(id)),
    );
    const providerRows = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.userId, user.id))
      .orderBy(providerConfigs.createdAt);
    const doc = {
      opendungen: EXPORT_VERSION,
      exportedAt: Date.now(),
      stories: bundles,
      scenarios: [...ownedScenarioRows.map(toExportScenarioFull), ...refs],
      // api_key_enc is deliberately absent: keys never leave the server.
      providerConfigs: providerRows.map(toExportProvider),
    };
    c.header(
      "Content-Disposition",
      `attachment; filename="opendungen-export-${doc.exportedAt}.json"`,
    );
    return c.json(doc);
  });
}
