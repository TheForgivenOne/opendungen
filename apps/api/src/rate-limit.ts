// D1-backed sliding-window rate limiting over the existing
// rate_limits table. Only the expensive endpoints are limited —
// everything else passes through untouched.

import { eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "./app";
import { rateLimits } from "./db/schema";

export const RATE_LIMIT_WINDOW_MS = 60_000;
const STALE_ROW_MS = 120_000;

// Method + Hono route pattern -> requests per window per key.
export const RATE_LIMITS: Record<string, number> = {
  "POST /api/stories/:id/generate": 60,
  "POST /api/stories/:id/retry": 60,
  "POST /api/providers/:id/test": 20,
  "POST /api/import": 10,
  "POST /api/auth/login": 10,
  "POST /api/auth/setup": 5,
};

export interface RateLimitVerdict {
  allowed: boolean;
  // Seconds until the window resets (for the Retry-After header).
  retryAfterSeconds: number;
}

// One row per key; UPSERT on each limited request. Stale rows (>2 min)
// are deleted lazily on every check instead of a cron job. Routes not
// in RATE_LIMITS always pass.
//
// All writes go through the query builder (never db.all on a bare
// INSERT/UPDATE/DELETE): better-sqlite3's .all() throws for
// non-reader statements while D1 tolerates them, so raw writes are
// not portable across the dual driver.
export async function checkRateLimit(
  db: AppDb,
  route: string,
  identity: string,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  const limit = RATE_LIMITS[route];
  if (typeof limit !== "number") {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const rowKey = `${route}:${identity}`;
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, now - STALE_ROW_MS));
  const existing = await db.all<{ window_start: number; count: number }>(
    sql`select window_start, count from rate_limits where key = ${rowKey}`,
  );
  const row = existing[0];
  if (!row || now - row.window_start >= RATE_LIMIT_WINDOW_MS) {
    await db
      .insert(rateLimits)
      .values({ key: rowKey, windowStart: now, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { windowStart: now, count: 1 },
      });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (row.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((row.window_start + RATE_LIMIT_WINDOW_MS - now) / 1000),
      ),
    };
  }
  await db
    .update(rateLimits)
    .set({ count: row.count + 1 })
    .where(eq(rateLimits.key, rowKey));
  return { allowed: true, retryAfterSeconds: 0 };
}
