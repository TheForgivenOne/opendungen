// Request middleware: request ids, error-shape rewrite, security
// headers, CORS, body limits, CSRF origin check, rate limiting, and
// the multi-mode gate. Registered before every route.
import { cors } from "hono/cors";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthUser } from "../app";
import { SESSION_COOKIE } from "../auth/session";
import { log, type LogFields } from "../log";
import { checkRateLimit } from "../rate-limit";
import { getSessionUser } from "../services/auth";
import { apiError } from "./http";
import type { AppRouter, RouteCtx } from "./types";

// Client identity for rate limiting and request logs: Cloudflare's
// connecting-IP header, else the first X-Forwarded-For hop.
function clientIp(c: Context): string | null {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) {
    return cf;
  }
  const forwarded = c.req.header("X-Forwarded-For")?.trim();
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) {
      return first;
    }
  }
  return null;
}

// Maps a request to its RATE_LIMITS route key, or null when the
// endpoint is not rate-limited. Matched manually (method + path
// shape) rather than via Hono internals so behaviour is explicit.
function rateLimitRoute(method: string, path: string): string | null {
  if (method !== "POST") {
    return null;
  }
  if (path === "/api/import") {
    return "POST /api/import";
  }
  if (path === "/api/auth/login") {
    return "POST /api/auth/login";
  }
  if (path === "/api/auth/setup") {
    return "POST /api/auth/setup";
  }
  const story = /^\/api\/stories\/[^/]+\/(generate|retry)$/.exec(path);
  if (story) {
    return `POST /api/stories/:id/${story[1]}`;
  }
  if (/^\/api\/providers\/[^/]+\/test$/.test(path)) {
    return "POST /api/providers/:id/test";
  }
  return null;
}

export function registerMiddleware(app: AppRouter, ctx: RouteCtx) {
  const { authMode, db, env, sessionSecret } = ctx;

  // ---- Phase 5: observability + hardening middleware ----
  // Registered before every route so they wrap all handlers. Post-next
  // work runs in reverse registration order, so the error-shape rewrite
  // (registered second) sees the final responses of everything below.

  // Request IDs: honour an incoming X-Request-Id, else generate a
  // UUID; the id is echoed back on every response.
  app.use(async (c, next) => {
    const incoming = c.req.header("X-Request-Id")?.trim().slice(0, 128);
    const requestId = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.header("X-Request-Id", requestId);
  });

  // Error responses carry the request id:
  // { error: { code, message, requestId } }.
  app.use(async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 400) {
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as { error?: unknown }).error !== "object" ||
      (body as { error?: unknown }).error === null ||
      "requestId" in ((body as { error?: object }).error as object)
    ) {
      return;
    }
    const error = (body as { error: Record<string, unknown> }).error;
    const requestId = c.get("requestId") as string | undefined;
    const headers = new Headers(res.headers);
    // The body changes size; length no longer applies, but every
    // other header (Retry-After, X-Request-Id, CORS, ...) survives.
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    c.res = new Response(
      JSON.stringify({ error: { ...error, ...(requestId ? { requestId } : {}) } }),
      { status: res.status, headers },
    );
  });

  // One info line per request. Only c.req.path is logged — never the
  // query string — so export/import params stay out of the logs.
  app.use(async (c, next) => {
    const start = Date.now();
    await next();
    const fields: LogFields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
      requestId: c.get("requestId"),
    };
    const user = c.get("user") as unknown as AuthUser | undefined;
    if (user) {
      fields.userId = user.id;
    }
    const ip = clientIp(c);
    if (ip) {
      fields.ip = ip;
    }
    log.info("request", fields);
  });

  // Security headers on every response. In dev (NODE_ENV
  // !== "production") connect-src also allows the Vite dev server
  // origin plus ws: so HMR keeps working; production is strict.
  // (These ride on API JSON responses — the page's own CSP governs
  // fetch — but defence in depth costs nothing here.)
  const connectSrc = env.isProduction
    ? "'self'"
    : "'self' http://127.0.0.1:5173 http://localhost:5173 ws://127.0.0.1:5173 ws://localhost:5173";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    // Tailwind injects styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  app.use(async (c, next) => {
    await next();
    c.header("Content-Security-Policy", contentSecurityPolicy);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  // Split deployments: when CORS_ORIGINS is set, the listed origins
  // may call /api/* with credentials. Unset means same-origin only
  // (no CORS headers at all; the browser enforces it).
  if (env.corsOrigins.length > 0) {
    app.use(
      "/api/*",
      cors({
        origin: env.corsOrigins,
        allowMethods: ["GET", "POST", "PATCH", "DELETE"],
        allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
        credentials: true,
      }),
    );
  }

  // Body size limits: 1 MB everywhere except POST /api/import (64 MB
  // for backup files). A declared Content-Length over the limit is
  // rejected without reading the body; without one, a clone is
  // measured so the handler still sees the original stream.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "POST" && c.req.method !== "PATCH" && c.req.method !== "PUT") {
      return next();
    }
    const limit = c.req.method === "POST" && c.req.path === "/api/import" ? 64_000_000 : 1_000_000;
    const declared = c.req.header("content-length");
    if (declared !== undefined && declared !== "") {
      const size = Number(declared);
      if (Number.isFinite(size) && size > limit) {
        return c.json(apiError("payload_too_large", "request body is too large"), 413);
      }
    } else {
      let size = 0;
      try {
        size = (await c.req.raw.clone().arrayBuffer()).byteLength;
      } catch {
        size = 0;
      }
      if (size > limit) {
        return c.json(apiError("payload_too_large", "request body is too large"), 413);
      }
    }
    return next();
  });

  // Belt-and-braces CSRF: mutating requests must carry an Origin (or
  // Referer fallback) matching the request's own origin. setup/login
  // are exempt — first-request flows from the login page that carry no
  // session cookie yet (SameSite=Lax already blocks cross-site cookie
  // sends). Requests with neither header (curl, tests, native apps)
  // are allowed; browsers always send Origin on POST/PATCH/DELETE.
  // CORS-listed origins are trusted too (like Django's
  // CSRF_TRUSTED_ORIGINS): without this, split deployments could
  // never mutate — the browser would send the frontend origin, which
  // differs from the API origin by design. The dev Vite proxy rewrites
  // Origin to the API origin (see apps/web/vite.config.ts).
  const CSRF_EXEMPT = new Set(["POST /api/auth/setup", "POST /api/auth/login"]);
  const corsOrigins = new Set<string>();
  for (const origin of env.corsOrigins) {
    try {
      corsOrigins.add(new URL(origin).origin);
    } catch {
      // Ignore malformed entries (the CORS middleware matches raw strings).
    }
  }
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "POST" && c.req.method !== "PATCH" && c.req.method !== "DELETE") {
      return next();
    }
    if (CSRF_EXEMPT.has(`${c.req.method} ${c.req.path}`)) {
      return next();
    }
    const claimed = c.req.header("Origin") ?? c.req.header("Referer");
    if (!claimed) {
      return next();
    }
    let claimedOrigin: string;
    try {
      claimedOrigin = new URL(claimed).origin;
    } catch {
      return c.json(apiError("forbidden", "invalid origin"), 403);
    }
    if (claimedOrigin !== new URL(c.req.url).origin && !corsOrigins.has(claimedOrigin)) {
      return c.json(apiError("forbidden", "origin not allowed"), 403);
    }
    return next();
  });

  // Rate limiting (only the expensive endpoints in RATE_LIMITS).
  // Keyed by user id when a session resolves, else by client IP.
  if (env.rateLimitEnabled) {
    app.use("/api/*", async (c, next) => {
      const route = rateLimitRoute(c.req.method, c.req.path);
      if (!route) {
        return next();
      }
      const verdict = await checkRateLimit(db, route, await rateLimitIdentity(c));
      if (!verdict.allowed) {
        c.header("Retry-After", String(verdict.retryAfterSeconds));
        return c.json(apiError("rate_limited", "rate limit exceeded; try again shortly"), 429);
      }
      return next();
    });
  }

  async function rateLimitIdentity(c: Context): Promise<string> {
    if (authMode === "none") {
      return "user:none";
    }
    try {
      const user = await getSessionUser(db, sessionSecret, getCookie(c, SESSION_COOKIE));
      if (user) {
        return `user:${user.id}`;
      }
    } catch {
      // Fall through to IP keying.
    }
    return `ip:${clientIp(c) ?? "unknown"}`;
  }

  // "multi" is reserved for a later phase: every API route 501s,
  // except the /api/health liveness probe.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/health/ready") {
      return next();
    }
    if (authMode === "multi") {
      return c.json(apiError("not_implemented", 'auth mode "multi" is not implemented'), 501);
    }
    return next();
  });
}
