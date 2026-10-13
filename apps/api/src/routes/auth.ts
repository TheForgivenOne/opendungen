// Auth routes: setup (first-run), login/logout, session reads.
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { apiError } from "./http";
import { toUser } from "./mappers";
import { credentialsSchema, invalidRequest } from "./schemas";
import type { AppRouter, RouteCtx } from "./types";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, verifySessionToken } from "../auth/session";
import { hashPassword, verifyPassword } from "../auth/password";
import { sessions, users } from "../db/schema";
import { anyUsers, getSessionUser, issueSession } from "../services/auth";

function setSessionCookie(c: Context, token: string) {
  // Secure cookies are only sent over HTTPS; local dev runs on plain
  // HTTP, so the Secure attribute is set only for https requests.
  const secure = c.req.url.startsWith("https://");
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
}

export function registerAuth(app: AppRouter, ctx: RouteCtx) {
  const { authMode, db, currentUser, requireAuth, sessionSecret } = ctx;

  app.get("/api/auth/state", async (c) => {
    if (authMode === "none") {
      return c.json({ mode: "none", needsSetup: false, authenticated: true });
    }
    const needsSetup = !(await anyUsers(db));
    const user = await getSessionUser(db, sessionSecret, getCookie(c, SESSION_COOKIE));
    return c.json({ mode: "single", needsSetup, authenticated: user !== null });
  });

  app.post("/api/auth/setup", zValidator("json", credentialsSchema, invalidRequest), async (c) => {
    if (await anyUsers(db)) {
      return c.json(apiError("already_setup", "an admin user already exists"), 409);
    }
    const body = c.req.valid("json");
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      email: body.email,
      passwordHash: hashPassword(body.password),
      instanceAdmin: 1,
      createdAt: now,
    };
    await db.insert(users).values(row);
    setSessionCookie(c, await issueSession(db, sessionSecret, row.id));
    return c.json({ user: toUser(row) }, 201);
  });

  app.post("/api/auth/login", zValidator("json", credentialsSchema, invalidRequest), async (c) => {
    const body = c.req.valid("json");
    const rows = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const row = rows[0];
    if (!row || !row.passwordHash || !verifyPassword(body.password, row.passwordHash)) {
      return c.json(apiError("invalid_credentials", "invalid email or password"), 401);
    }
    setSessionCookie(c, await issueSession(db, sessionSecret, row.id));
    return c.json({ user: toUser(row) });
  });

  app.post("/api/auth/logout", async (c) => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (raw) {
      const claims = await verifySessionToken(sessionSecret, raw);
      if (claims) {
        await db.delete(sessions).where(eq(sessions.id, claims.sessionId));
      }
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (c) => {
    return c.json({ user: currentUser(c) });
  });

  app.post("/api/auth/logout-all", requireAuth, async (c) => {
    const user = currentUser(c);
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
}
