import { SignJWT, jwtVerify } from "jose";

// Session cookie name (frozen decision, see PROGRESS.md).
export const SESSION_COOKIE = "opendungen_session";
// 30-day session expiry, in seconds.
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionClaims {
  userId: string;
  sessionId: string;
}

const encoder = new TextEncoder();

export async function createSessionToken(secret: string, claims: SessionClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(encoder.encode(secret));
}

export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret));
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}
