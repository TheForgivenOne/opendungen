// Scenario routes: browse/detail plus user-owned authoring
// (create/edit/delete/duplicate; builtins are read-only).
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { scenarios, stories } from "../db/schema";
import { apiError } from "./http";
import { toScenarioDetail, toScenarioListItem } from "./mappers";
import { invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";

export function registerScenarios(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, requireAuth } = ctx;

  app.get("/api/scenarios", requireAuth, async (c) => {
    const rows = await db.select().from(scenarios).orderBy(scenarios.title);
    return c.json({ scenarios: rows.map(toScenarioListItem) });
  });

  app.get("/api/scenarios/:id", requireAuth, async (c) => {
    const rows = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, c.req.param("id")))
      .limit(1);
    const scenario = rows[0];
    if (!scenario) {
      return c.json(apiError("not_found", "scenario not found"), 404);
    }
    return c.json({ scenario: toScenarioDetail(scenario) });
  });

  // ---- scenario authoring (Phase 4) ----
  // Rows with user_id set are user-owned and editable; null user_id
  // means builtin (read-only). In single-user modes every non-builtin
  // row belongs to the caller, so editability is exactly !builtin.

  const scenarioFieldsSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(20000),
    opening: z.string().max(20000),
    aiInstructions: z.string().max(20000),
    tags: z.array(z.string().min(1).max(200)).max(50).optional(),
  });

  const patchScenarioSchema = scenarioFieldsSchema
    .partial()
    .refine((o) => Object.keys(o).length > 0, {
      message: "at least one field is required",
    });

  function scenarioTags(body: { tags?: string[] }): string {
    const cleaned = (body.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    return JSON.stringify(cleaned);
  }

  app.post(
    "/api/scenarios",
    requireAuth,
    zValidator("json", scenarioFieldsSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const body = c.req.valid("json");
      const row = {
        id: crypto.randomUUID(),
        title: body.title,
        description: body.description,
        opening: body.opening,
        aiInstructions: body.aiInstructions,
        tags: scenarioTags(body),
        builtin: 0,
        userId: user.id,
      };
      await db.insert(scenarios).values(row);
      return c.json({ scenario: toScenarioDetail(row) }, 201);
    },
  );

  app.patch(
    "/api/scenarios/:id",
    requireAuth,
    zValidator("json", patchScenarioSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const found = await db
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, c.req.param("id")))
        .limit(1);
      const scenario = found[0];
      if (!scenario) {
        return c.json(apiError("not_found", "scenario not found"), 404);
      }
      if (scenario.builtin === 1 || scenario.userId !== user.id) {
        return c.json(apiError("forbidden", "scenario is read-only"), 403);
      }
      const body = c.req.valid("json");
      const patch: {
        title?: string;
        description?: string;
        opening?: string;
        aiInstructions?: string;
        tags?: string;
      } = {};
      if (body.title !== undefined) {
        patch.title = body.title;
      }
      if (body.description !== undefined) {
        patch.description = body.description;
      }
      if (body.opening !== undefined) {
        patch.opening = body.opening;
      }
      if (body.aiInstructions !== undefined) {
        patch.aiInstructions = body.aiInstructions;
      }
      if (body.tags !== undefined) {
        patch.tags = scenarioTags(body);
      }
      await db.update(scenarios).set(patch).where(eq(scenarios.id, scenario.id));
      return c.json({ scenario: toScenarioDetail({ ...scenario, ...patch }) });
    },
  );

  app.delete("/api/scenarios/:id", requireAuth, async (c) => {
    const user = currentUser(c);
    const found = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, c.req.param("id")))
      .limit(1);
    const scenario = found[0];
    if (!scenario) {
      return c.json(apiError("not_found", "scenario not found"), 404);
    }
    if (scenario.builtin === 1 || scenario.userId !== user.id) {
      return c.json(apiError("forbidden", "scenario is read-only"), 403);
    }
    // Stories survive with their scenario unlinked; scenario scripts
    // cascade via the foreign key.
    await db.update(stories).set({ scenarioId: null }).where(eq(stories.scenarioId, scenario.id));
    await db.delete(scenarios).where(eq(scenarios.id, scenario.id));
    return c.json({ ok: true });
  });

  app.post("/api/scenarios/:id/duplicate", requireAuth, async (c) => {
    const user = currentUser(c);
    const found = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, c.req.param("id")))
      .limit(1);
    const scenario = found[0];
    if (!scenario) {
      return c.json(apiError("not_found", "scenario not found"), 404);
    }
    // Fields only: attached scripts stay with the original scenario.
    const row = {
      id: crypto.randomUUID(),
      title: scenario.title,
      description: scenario.description,
      opening: scenario.opening,
      aiInstructions: scenario.aiInstructions,
      tags: scenario.tags,
      builtin: 0,
      userId: user.id,
    };
    await db.insert(scenarios).values(row);
    return c.json({ scenario: toScenarioDetail(row) }, 201);
  });
}
