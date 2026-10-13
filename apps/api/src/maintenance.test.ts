import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { createApp } from "./app";
import { createSessionToken } from "./auth/session";
import { compressedRanges, rateLimits, scriptStates, sessions, users } from "./db/schema";
import { createTestApp, setupAdmin, TEST_SECRET, createStoryRows } from "./testing";

type App = ReturnType<typeof createApp>;

async function postCleanup(app: App, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) {
    headers.cookie = cookie;
  }
  return app.request("/api/admin/cleanup", { method: "POST", headers });
}

describe("POST /api/admin/cleanup", () => {
  it("deletes expired sessions and keeps live ones", async () => {
    const { app, db } = createTestApp();
    const { cookie, userId } = await setupAdmin(app);
    const now = Date.now();
    await db.insert(sessions).values({ id: "dead-session", userId, expiresAt: now - 1000 });
    await db.insert(sessions).values({ id: "live-session", userId, expiresAt: now + 60_000 });

    const res = await postCleanup(app, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: {
        sessions: number;
        rateLimits: number;
        scriptStates: number;
        compressedRanges: number;
      };
    };
    expect(body.deleted.sessions).toBe(1);
    const remaining = await db.all<{ id: string }>(sql`select id from sessions`);
    expect(remaining.map((r) => r.id)).toContain("live-session");
    expect(remaining.map((r) => r.id)).not.toContain("dead-session");
  });

  it("sweeps stale rate limits, orphan states, and inverted ranges", async () => {
    const { app, db } = createTestApp();
    const { cookie } = await setupAdmin(app);
    const now = Date.now();
    await db.insert(rateLimits).values([
      { key: "POST /api/auth/login|ip:x", windowStart: now - 300_000, count: 3 },
      { key: "fresh", windowStart: now, count: 1 },
    ]);
    // Orphan state: impossible through the API (FK), so the pragma is
    // lifted on the raw connection for seeding only, then restored.
    const raw = db.$client as unknown as { pragma: (stmt: string) => void };
    raw.pragma("foreign_keys = OFF");
    const { storyId } = await createStoryRows(db);
    await db
      .insert(scriptStates)
      .values({ scriptId: "ghost", storyId, state: "{}", updatedAt: now });
    await db.insert(compressedRanges).values({
      id: "bad",
      storyId,
      startIdx: 5,
      endIdx: 5,
      summary: "x",
      parentRangeId: null,
      createdAt: now,
    });
    raw.pragma("foreign_keys = ON");

    const res = await postCleanup(app, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: {
        sessions: number;
        rateLimits: number;
        scriptStates: number;
        compressedRanges: number;
      };
    };
    expect(body.deleted.rateLimits).toBe(1);
    expect(body.deleted.scriptStates).toBe(1);
    expect(body.deleted.compressedRanges).toBe(1);
  });

  it("rejects non-admins with 403 in single mode", async () => {
    const { app, db } = createTestApp();
    await setupAdmin(app);
    // A second, non-admin user with a live session.
    const userId = "plain-user";
    const now = Date.now();
    await db.insert(users).values({
      id: userId,
      email: "plain@example.com",
      passwordHash: null,
      instanceAdmin: 0,
      createdAt: now,
    });
    await db.insert(sessions).values({ id: "plain-session", userId, expiresAt: now + 60_000 });
    const token = await createSessionToken(TEST_SECRET, { userId, sessionId: "plain-session" });

    const res = await postCleanup(app, `opendungen_session=${token}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("requires authentication in single mode", async () => {
    const { app } = createTestApp();
    await setupAdmin(app);
    const res = await postCleanup(app);
    expect(res.status).toBe(401);
  });

  it("is open in none mode", async () => {
    const { app } = createTestApp("none");
    const res = await postCleanup(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: Record<string, number> };
    expect(typeof body.deleted.sessions).toBe("number");
  });
});
