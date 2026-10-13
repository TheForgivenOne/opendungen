// Session and user provisioning: first-run admin setup, session
// lookup/issuance. Pure data access over AppDb; HTTP concerns
// (cookies, guards) live in the route layer.

import { eq } from "drizzle-orm";
import type { AppDb, AuthUser } from "../app";
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from "../auth/session";
import { sessions, users } from "../db/schema";
import { toUser } from "../routes/mappers";

export async function anyUsers(db: AppDb): Promise<boolean> {
  const rows = await db.select().from(users).limit(1);
  return rows.length > 0;
}

export async function ensureNoneAdmin(db: AppDb): Promise<AuthUser> {
  const rows = await db.select().from(users).where(eq(users.instanceAdmin, 1)).limit(1);
  if (rows[0]) {
    return toUser(rows[0]);
  }
  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    email: "admin@localhost",
    passwordHash: null,
    instanceAdmin: 1,
    createdAt: now,
  };
  await db.insert(users).values(row);
  return toUser(row);
}

export async function getSessionUser(
  db: AppDb,
  sessionSecret: string,
  cookieValue: string | undefined,
): Promise<AuthUser | null> {
  if (!cookieValue) {
    return null;
  }
  const claims = await verifySessionToken(sessionSecret, cookieValue);
  if (!claims) {
    return null;
  }
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, claims.sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session || session.userId !== claims.userId || session.expiresAt <= Date.now()) {
    return null;
  }
  const userRows = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);
  if (!userRows[0]) {
    return null;
  }
  return toUser(userRows[0]);
}

export async function issueSession(
  db: AppDb,
  sessionSecret: string,
  userId: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  return createSessionToken(sessionSecret, { userId, sessionId });
}
