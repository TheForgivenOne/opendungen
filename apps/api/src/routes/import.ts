// Import route: validated backup files become new rows with fresh
// ids and remapped foreign keys (merge or confirmed replace).
import { eq } from "drizzle-orm";
import {
  actions,
  compressedRanges,
  providerConfigs,
  scenarios,
  scriptStates,
  scripts,
  sessions,
  stories,
  storyCards,
} from "../db/schema";
import {
  validateImportDoc,
  MAX_IMPORT_BYTES,
  inOverrideRange,
  type ImportSkipped,
  type NormalizedImportDoc,
} from "../services/import";
import { encryptSecret } from "../crypto";
import { apiError } from "./http";
import type { AppRouter, RouteCtx } from "./types";

export function registerImport(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth, sessionSecret } = ctx;

  // Inserts a normalized doc as new rows with fresh ids, remapping
  // every foreign key. All data attaches to the calling user; the
  // file's user identity (if any) is never imported.
  async function applyImportDoc(
    userId: string,
    doc: NormalizedImportDoc,
    skipped: ImportSkipped[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {
      stories: 0,
      actions: 0,
      cards: 0,
      ranges: 0,
      scripts: 0,
      states: 0,
      scenarios: 0,
      providers: 0,
    };
    const providerMap = new Map<string, string>();
    if (doc.providerConfigs.some((p) => p.isDefault)) {
      await db
        .update(providerConfigs)
        .set({ isDefault: 0 })
        .where(eq(providerConfigs.userId, userId));
    }
    for (const p of doc.providerConfigs) {
      const id = crypto.randomUUID();
      providerMap.set(p.id, id);
      // Keys are never imported, even when present: users re-enter them.
      await db.insert(providerConfigs).values({
        id,
        userId,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKeyEnc: await encryptSecret(sessionSecret, ""),
        isDefault: p.isDefault ? 1 : 0,
        createdAt: p.createdAt,
      });
      counts.providers++;
    }
    const scenarioMap = new Map<string, string>();
    const refIds = new Set<string>();
    for (const s of doc.scenarios) {
      if (!("opening" in s)) {
        refIds.add(s.id);
        continue;
      }
      const id = crypto.randomUUID();
      scenarioMap.set(s.id, id);
      await db.insert(scenarios).values({
        id,
        title: s.title,
        description: s.description,
        opening: s.opening,
        aiInstructions: s.aiInstructions,
        tags: JSON.stringify(s.tags),
        builtin: 0,
        userId,
      });
      counts.scenarios++;
    }
    for (const bundle of doc.stories) {
      const s = bundle.story;
      const storyId = crypto.randomUUID();
      let scenarioId: string | null = null;
      if (s.scenarioId !== null) {
        const mapped = scenarioMap.get(s.scenarioId);
        if (mapped) {
          scenarioId = mapped;
        } else if (refIds.has(s.scenarioId)) {
          const found = await db
            .select()
            .from(scenarios)
            .where(eq(scenarios.id, s.scenarioId))
            .limit(1);
          if (found[0]) {
            scenarioId = found[0].id;
          } else {
            skipped.push({
              entity: "story.scenarioId",
              id: s.id,
              reason: `referenced scenario ${s.scenarioId} is not on this instance; unlinked`,
            });
          }
        }
      }
      let providerId: string | null = null;
      if (s.providerId !== null) {
        const mapped = providerMap.get(s.providerId);
        if (mapped) {
          providerId = mapped;
        } else {
          skipped.push({
            entity: "story.providerId",
            id: s.id,
            reason: `referenced provider ${s.providerId} was not imported; using default`,
          });
        }
      }
      const overrides: {
        compressTriggerPct: number | null;
        compressMaxTokens: number | null;
        compressTemperature: number | null;
        contextTokens: number | null;
        maxOutputTokens: number | null;
      } = {
        compressTriggerPct: null,
        compressMaxTokens: null,
        compressTemperature: null,
        contextTokens: null,
        maxOutputTokens: null,
      };
      for (const field of Object.keys(overrides) as (keyof typeof overrides)[]) {
        const value = s[field] ?? null;
        if (value !== null && !inOverrideRange(field, value)) {
          skipped.push({
            entity: `story.${field}`,
            id: s.id,
            reason: `${field} out of range; reset to default`,
          });
        } else {
          overrides[field] = value;
        }
      }
      await db.insert(stories).values({
        id: storyId,
        userId,
        scenarioId,
        title: s.title,
        aiInstructions: s.aiInstructions,
        plotEssentials: s.plotEssentials,
        memory: s.memory,
        summary: s.summary,
        deletedAt: null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        providerId,
        ...overrides,
        completedAt: typeof s.completedAt === "number" ? s.completedAt : null,
      });
      counts.stories++;
      for (const a of bundle.actions) {
        await db.insert(actions).values({
          id: crypto.randomUUID(),
          storyId,
          idx: a.idx,
          type: a.type,
          text: a.text,
          mode: a.mode === "do" || a.mode === "say" || a.mode === "story" ? a.mode : null,
          createdAt: a.createdAt,
        });
        counts.actions++;
      }
      for (const card of bundle.cards) {
        await db.insert(storyCards).values({
          id: crypto.randomUUID(),
          storyId,
          keys: JSON.stringify(card.keys),
          entry: card.entry,
          enabled: card.enabled ? 1 : 0,
        });
        counts.cards++;
      }
      // Ranges insert parents before children: the self-referencing
      // FK is checked per row on enforcing drivers.
      const rangeMap = new Map<string, string>();
      for (const r of bundle.ranges) {
        rangeMap.set(r.id, crypto.randomUUID());
      }
      const pending = [...bundle.ranges];
      const inserted = new Set<string>();
      while (pending.length > 0) {
        const before = pending.length;
        for (let i = pending.length - 1; i >= 0; i--) {
          const r = pending[i];
          if (r.parentRangeId !== null && !inserted.has(r.parentRangeId)) {
            continue;
          }
          await db.insert(compressedRanges).values({
            id: rangeMap.get(r.id) as string,
            storyId,
            startIdx: r.startIdx,
            endIdx: r.endIdx,
            summary: r.summary,
            parentRangeId:
              r.parentRangeId === null ? null : (rangeMap.get(r.parentRangeId) as string),
            createdAt: r.createdAt,
          });
          inserted.add(r.id);
          pending.splice(i, 1);
          counts.ranges++;
        }
        if (pending.length === before) {
          // Unreachable after validation (parents always in-file),
          // but never spin forever on hostile input.
          for (const r of pending) {
            skipped.push({
              entity: "range",
              id: r.id,
              reason: "parent range could not be resolved; skipped",
            });
          }
          break;
        }
      }
      const scriptMap = new Map<string, string>();
      for (const script of bundle.scripts) {
        const id = crypto.randomUUID();
        scriptMap.set(script.id, id);
        // Scenario scripts only ever attach to full (imported)
        // scenarios; validation guarantees the mapping exists.
        const scenarioId =
          script.scenarioId === null ? null : (scenarioMap.get(script.scenarioId) as string);
        await db.insert(scripts).values({
          id,
          storyId: script.storyId === null ? null : storyId,
          scenarioId,
          name: script.name,
          source: script.source,
          enabled: script.enabled ? 1 : 0,
          position: script.position,
          createdAt: script.createdAt,
        });
        counts.scripts++;
      }
      for (const state of bundle.states) {
        let parsed = true;
        try {
          JSON.parse(state.state);
        } catch {
          parsed = false;
        }
        if (!parsed) {
          skipped.push({
            entity: "script_state",
            id: state.scriptId,
            reason: "state is not valid JSON; reset to {}",
          });
        }
        await db.insert(scriptStates).values({
          scriptId: scriptMap.get(state.scriptId) as string,
          storyId,
          state: parsed ? state.state : "{}",
          updatedAt: state.updatedAt,
        });
        counts.states++;
      }
    }
    return counts;
  }

  app.post("/api/import", requireAuth, async (c) => {
    const user = currentUser(c);
    const mode = c.req.query("mode") ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      return c.json(apiError("validation_error", "mode must be merge or replace"), 400);
    }
    if (mode === "replace" && c.req.query("confirm") !== "DELETE") {
      return c.json(apiError("validation_error", "replace mode requires ?confirm=DELETE"), 400);
    }
    let form: Record<string, unknown>;
    try {
      form = (await c.req.parseBody()) as unknown as Record<string, unknown>;
    } catch {
      return c.json(apiError("validation_error", "expected multipart/form-data"), 400);
    }
    let upload = form["file"];
    if (Array.isArray(upload)) {
      upload = upload[0];
    }
    if (
      !upload ||
      typeof upload !== "object" ||
      typeof (upload as { text?: unknown }).text !== "function"
    ) {
      return c.json(apiError("validation_error", 'a file upload named "file" is required'), 400);
    }
    const text = await (upload as { text(): Promise<string> }).text();
    if (text.length > MAX_IMPORT_BYTES) {
      return c.json(apiError("validation_error", "file is too large"), 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return c.json(apiError("validation_error", "file is not valid JSON"), 400);
    }
    const validated = validateImportDoc(parsed);
    if ("reason" in validated) {
      return c.json(apiError("validation_error", validated.reason), 400);
    }
    if (mode === "replace") {
      // Delete ALL user data first: stories cascade to actions, cards,
      // ranges, story scripts and states; user scenarios cascade to
      // their scripts. Builtin scenarios and the user row survive.
      // Sessions are revoked too, including the current one — replace
      // ends logged out; log back in afterwards.
      const userStories = await db.select().from(stories).where(eq(stories.userId, user.id));
      for (const story of userStories) {
        await db.delete(stories).where(eq(stories.id, story.id));
      }
      await db.delete(scenarios).where(eq(scenarios.userId, user.id));
      await db.delete(providerConfigs).where(eq(providerConfigs.userId, user.id));
      await db.delete(sessions).where(eq(sessions.userId, user.id));
    }
    const skipped: ImportSkipped[] = [];
    const imported = await applyImportDoc(user.id, validated.doc, skipped);
    return c.json({ imported, skipped });
  });
}
