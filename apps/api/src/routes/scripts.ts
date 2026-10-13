// Script routes: story- and scenario-scoped CRUD plus validation.
// One owner per script (story XOR scenario); scenario scripts run
// before story scripts at every hook.
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { scenarios, scripts } from "../db/schema";
import { liveStory } from "../services/stories";
import { apiError } from "./http";
import { toScript } from "./mappers";
import { invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";
import { validateScript } from "../scripts/runner";

export function registerScripts(app: AppRouter, ctx: RouteCtx) {
  const { currentUser, db, env, requireAuth } = ctx;

  const createScriptSchema = z.object({
    name: z.string().min(1).max(200),
    source: z.string().min(1).max(100000),
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).max(1000000).optional(),
  });

  const patchScriptSchema = z
    .object({
      name: z.string().min(1).max(200).optional(),
      source: z.string().min(1).max(100000).optional(),
      enabled: z.boolean().optional(),
      position: z.number().int().min(0).max(1000000).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, {
      message: "at least one field is required",
    });

  const validateScriptSchema = z.object({
    source: z.string().min(1).max(100000),
  });

  async function liveScenario(id: string) {
    const rows = await db.select().from(scenarios).where(eq(scenarios.id, id)).limit(1);
    return rows[0] ?? null;
  }

  function listScriptsWhere(where: ReturnType<typeof eq>) {
    return db.select().from(scripts).where(where).orderBy(scripts.position, scripts.id);
  }

  // Shared PATCH/DELETE target: a story script requires ownership of its
  // story; a scenario script requires its scenario to exist (scenarios
  // are global resources, like the builtin list itself).
  async function ownedScript(userId: string, scriptId: string) {
    const rows = await db.select().from(scripts).where(eq(scripts.id, scriptId)).limit(1);
    const script = rows[0] ?? null;
    if (!script) {
      return null;
    }
    if (script.storyId) {
      const story = await liveStory(db, userId, script.storyId);
      if (!story) {
        return null;
      }
    } else if (script.scenarioId) {
      const scenario = await liveScenario(script.scenarioId);
      if (!scenario) {
        return null;
      }
    } else {
      return null;
    }
    return script;
  }

  app.get("/api/scenarios/:id/scripts", requireAuth, async (c) => {
    const scenario = await liveScenario(c.req.param("id"));
    if (!scenario) {
      return c.json(apiError("not_found", "scenario not found"), 404);
    }
    const rows = await listScriptsWhere(eq(scripts.scenarioId, scenario.id));
    return c.json({ scripts: rows.map(toScript), readOnly: scenario.builtin === 1 });
  });

  app.post(
    "/api/scenarios/:id/scripts",
    requireAuth,
    zValidator("json", createScriptSchema, invalidRequest),
    async (c) => {
      const scenario = await liveScenario(c.req.param("id"));
      if (!scenario) {
        return c.json(apiError("not_found", "scenario not found"), 404);
      }
      const body = c.req.valid("json");
      const row = {
        id: crypto.randomUUID(),
        storyId: null,
        scenarioId: scenario.id,
        name: body.name,
        source: body.source,
        enabled: (body.enabled ?? true) ? 1 : 0,
        position: body.position ?? 0,
        createdAt: Date.now(),
      };
      await db.insert(scripts).values(row);
      return c.json({ script: toScript(row) }, 201);
    },
  );

  app.get("/api/stories/:id/scripts", requireAuth, async (c) => {
    const user = currentUser(c);
    const row = await liveStory(db, user.id, c.req.param("id"));
    if (!row) {
      return c.json(apiError("not_found", "story not found"), 404);
    }
    const rows = await listScriptsWhere(eq(scripts.storyId, row.id));
    return c.json({ scripts: rows.map(toScript), readOnly: false });
  });

  app.post(
    "/api/stories/:id/scripts",
    requireAuth,
    zValidator("json", createScriptSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const row = await liveStory(db, user.id, c.req.param("id"));
      if (!row) {
        return c.json(apiError("not_found", "story not found"), 404);
      }
      const body = c.req.valid("json");
      const scriptRow = {
        id: crypto.randomUUID(),
        storyId: row.id,
        scenarioId: null,
        name: body.name,
        source: body.source,
        enabled: (body.enabled ?? true) ? 1 : 0,
        position: body.position ?? 0,
        createdAt: Date.now(),
      };
      await db.insert(scripts).values(scriptRow);
      return c.json({ script: toScript(scriptRow) }, 201);
    },
  );

  app.patch(
    "/api/scripts/:scriptId",
    requireAuth,
    zValidator("json", patchScriptSchema, invalidRequest),
    async (c) => {
      const user = currentUser(c);
      const script = await ownedScript(user.id, c.req.param("scriptId"));
      if (!script) {
        return c.json(apiError("not_found", "script not found"), 404);
      }
      const body = c.req.valid("json");
      const patch: { name?: string; source?: string; enabled?: number; position?: number } = {};
      if (body.name !== undefined) {
        patch.name = body.name;
      }
      if (body.source !== undefined) {
        patch.source = body.source;
      }
      if (body.enabled !== undefined) {
        patch.enabled = body.enabled ? 1 : 0;
      }
      if (body.position !== undefined) {
        patch.position = body.position;
      }
      await db.update(scripts).set(patch).where(eq(scripts.id, script.id));
      return c.json({ script: toScript({ ...script, ...patch }) });
    },
  );

  app.delete("/api/scripts/:scriptId", requireAuth, async (c) => {
    const user = currentUser(c);
    const script = await ownedScript(user.id, c.req.param("scriptId"));
    if (!script) {
      return c.json(apiError("not_found", "script not found"), 404);
    }
    // script_states rows cascade.
    await db.delete(scripts).where(eq(scripts.id, script.id));
    return c.json({ ok: true });
  });

  app.post(
    "/api/scripts/validate",
    requireAuth,
    zValidator("json", validateScriptSchema, invalidRequest),
    async (c) => {
      if (!env.scriptsEnabled) {
        return c.json({ ok: false, error: "scripts are disabled on this instance" });
      }
      const body = c.req.valid("json");
      return c.json(await validateScript(body.source));
    },
  );
}
