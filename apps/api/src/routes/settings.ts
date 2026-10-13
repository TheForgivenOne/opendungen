// Settings routes: instance flags plus admin maintenance and the
// account summary.
import { and, eq, inArray, isNull } from "drizzle-orm";
import apiPackage from "../../package.json";
import { getCookie } from "hono/cookie";
import { actions, compressedRanges, stories, users } from "../db/schema";
import { SESSION_COOKIE } from "../auth/session";
import { log } from "../log";
import { cleanup } from "../maintenance";
import { anyUsers, getSessionUser } from "../services/auth";
import { apiError } from "./http";
import type { AppRouter, RouteCtx } from "./types";

export function registerSettings(app: AppRouter, ctx: RouteCtx) {
  const { authMode, currentUser, db, env, requireAuth, sessionSecret } = ctx;

  app.get("/api/settings/instance", requireAuth, async (c) => {
    return c.json({
      authMode,
      version: apiPackage.version,
      hasSessionSecret: sessionSecret.length > 0,
      setupComplete: await anyUsers(db),
      // Hardening/observability posture for the settings UI.
      rateLimitEnabled: env.rateLimitEnabled,
      allowPrivateProviderUrls: env.allowPrivateProviderUrls,
      logLevel: env.logLevel,
    });
  });

  // Data maintenance (no cron — self-hosters call this from their own
  // scheduler). AUTH_MODE=none allows it outright; otherwise only
  // instance admins. (Under AUTH_MODE=multi the /api/* 501 above still
  // applies, since no sessions can exist there.)
  app.post("/api/admin/cleanup", async (c) => {
    if (authMode !== "none") {
      const user = await getSessionUser(db, sessionSecret, getCookie(c, SESSION_COOKIE));
      if (!user) {
        return c.json(apiError("unauthorized", "authentication required"), 401);
      }
      if (!user.instanceAdmin) {
        return c.json(apiError("forbidden", "instance admin required"), 403);
      }
      c.set("user", user);
    }
    const deleted = await cleanup(db);
    log.info("maintenance cleanup", {
      requestId: c.get("requestId") as string | undefined,
      ...deleted,
    });
    return c.json({ deleted });
  });

  app.get("/api/settings/account", requireAuth, async (c) => {
    const user = currentUser(c);
    const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const full = userRows[0];
    if (!full) {
      return c.json(apiError("not_found", "user not found"), 404);
    }
    // No .select() projections: the WorkerDb/LocalDb union breaks
    // select-with-args overloads, so ids are read from full rows.
    const liveStories = await db
      .select()
      .from(stories)
      .where(and(eq(stories.userId, user.id), isNull(stories.deletedAt)));
    const storyIds = liveStories.map((r) => r.id);
    let actionCount = 0;
    let rangeCount = 0;
    if (storyIds.length > 0) {
      const actionRows = await db.select().from(actions).where(inArray(actions.storyId, storyIds));
      actionCount = actionRows.length;
      const rangeRows = await db
        .select()
        .from(compressedRanges)
        .where(inArray(compressedRanges.storyId, storyIds));
      rangeCount = rangeRows.length;
    }
    return c.json({
      user: {
        id: full.id,
        email: full.email,
        instanceAdmin: full.instanceAdmin === 1,
        createdAt: full.createdAt,
      },
      counts: { stories: storyIds.length, actions: actionCount, ranges: rangeCount },
    });
  });
}
