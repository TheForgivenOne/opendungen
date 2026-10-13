// Health probes (no auth): liveness plus database readiness.
import { sql } from "drizzle-orm";
import apiPackage from "../../package.json";
import { apiError } from "./http";
import type { AppRouter, RouteCtx } from "./types";

export function registerHealth(app: AppRouter, ctx: RouteCtx) {
  const { db } = ctx;

  app.get("/api/health", (c) => {
    return c.json({ ok: true, service: "opendungen", version: apiPackage.version });
  });

  // Readiness probe: 200 when the database answers, else 503. No auth,
  // and the (local) database path is never logged or returned.
  app.get("/api/health/ready", async (c) => {
    try {
      await db.all(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json(apiError("not_ready", "database unreachable"), 503);
    }
  });
}
