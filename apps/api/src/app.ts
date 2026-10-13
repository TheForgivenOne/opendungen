import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { log, setLogLevel } from "./log";
import { SESSION_COOKIE } from "./auth/session";
import type { LocalDb } from "./db.local";
import type { WorkerDb } from "./db";
import { createProvider, type LLMProvider, type ProviderConfigInput } from "./llm";
// Instance version shown on the settings screen.

// Either production driver (D1) or the local driver (better-sqlite3).
// All queries below use the shared Drizzle query-builder API and `await`,
// which works for both the sync local driver and the async D1 driver.
export type AppDb = WorkerDb | LocalDb;

export type AuthMode = "none" | "single" | "multi";

// Phase 5 runtime environment. Every field is optional at construction
// and merges over DEFAULT_ENV; index.ts (Workers) and node.ts (Node)
// build it from their respective env sources. Tests pass partial envs.
export interface AppEnv {
  // RATE_LIMIT_ENABLED (default "true"); "false" skips limiting.
  rateLimitEnabled: boolean;
  // ALLOW_PRIVATE_PROVIDER_URLS (default "false"); "true" lets
  // provider baseUrls point at LAN/loopback hosts (local Ollama).
  allowPrivateProviderUrls: boolean;
  // CORS_ORIGINS, comma-separated (default: same-origin only).
  corsOrigins: string[];
  // LOG_LEVEL (default "info"); "debug" enables debug lines.
  logLevel: string;
  // SENTRY_DSN (default ""): reserved error-reporting hook.
  // Documented only — no Sentry SDK ships (see PROGRESS.md).
  sentryDsn: string;
  // INSTANCE_SCRIPTS_ENABLED (default "true"); "false" makes
  // scripts a no-op so a deploy without working QuickJS WASM still
  // functions (see the Scripts section of ARCHITECTURE.md).
  scriptsEnabled: boolean;
  // NODE_ENV === "production" serves the strict CSP; anything else
  // relaxes connect-src for the Vite dev server + HMR websocket.
  isProduction: boolean;
}

export const DEFAULT_ENV: AppEnv = {
  rateLimitEnabled: true,
  allowPrivateProviderUrls: false,
  corsOrigins: [],
  logLevel: "info",
  sentryDsn: "",
  scriptsEnabled: true,
  isProduction: false,
};

export interface AppOptions {
  db: AppDb;
  authMode: AuthMode;
  sessionSecret: string;
  // Builds a live provider from a decrypted config. Overridable in
  // tests to inject a mock; production uses the real factory.
  createProviderFn?: (config: ProviderConfigInput) => LLMProvider;
  env?: Partial<AppEnv>;
}

// Once-per-isolate guards: createApp runs per request on Workers, so
// boot warnings must not live in the closure.
let privateUrlsWarningLogged = false;

export interface AuthUser {
  id: string;
  email: string | null;
  instanceAdmin: boolean;
}

import { apiError } from "./routes/http";
import { registerActions } from "./routes/actions";
import { registerAuth } from "./routes/auth";
import { registerCards } from "./routes/cards";
import { registerGenerate } from "./routes/generate";
import { registerHealth } from "./routes/health";
import { registerMiddleware } from "./routes/middleware";
import { registerExport } from "./routes/export";
import { registerImport } from "./routes/import";
import { registerProviderOps } from "./routes/provider-ops";
import { registerRanges } from "./routes/ranges";
import { registerScripts } from "./routes/scripts";
import { registerSettings } from "./routes/settings";
import { registerScenarios } from "./routes/scenarios";
import { registerProviders } from "./routes/providers";
import { registerStories } from "./routes/stories";
import type { RouteCtx } from "./routes/types";
import { ensureNoneAdmin, getSessionUser } from "./services/auth";

export function createApp(options: AppOptions) {
  const { db, authMode, sessionSecret } = options;
  const buildProvider = options.createProviderFn ?? createProvider;
  const env: AppEnv = { ...DEFAULT_ENV, ...options.env };
  setLogLevel(env.logLevel);
  if (env.allowPrivateProviderUrls && !privateUrlsWarningLogged) {
    privateUrlsWarningLogged = true;
    log.warn("ALLOW_PRIVATE_PROVIDER_URLS=true: provider SSRF checks allow private IPs");
  }
  const app = new Hono<{ Variables: { user: AuthUser; requestId: string } }>();

  // Shared route context: data plus the bound auth closures. Route
  // files destructure what they need so handler bodies stay verbatim.
  // (requireAuth/currentUser are hoisted function declarations, so
  // referencing them here is safe.)
  const ctx: RouteCtx = {
    db,
    env,
    authMode,
    sessionSecret,
    buildProvider,
    requireAuth,
    currentUser,
  };

  app.onError((err, c) => {
    const requestId = c.get("requestId") as string | undefined;
    log.error("unhandled error", {
      requestId: requestId ?? null,
      error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
    });
    return c.json(
      { error: { code: "internal_error", message: "internal server error", requestId } },
      500,
    );
  });
  app.notFound((c) => c.json(apiError("not_found", "not found"), 404));

  // Hono infers route params (c.req.param) from the middleware chain; a
  // concrete Context type here widens every downstream param.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  async function requireAuth(c: any, next: () => Promise<void>) {
    const user =
      authMode === "none"
        ? await ensureNoneAdmin(db)
        : await getSessionUser(db, sessionSecret, getCookie(c, SESSION_COOKIE));
    if (!user) {
      return c.json(apiError("unauthorized", "authentication required"), 401);
    }
    c.set("user", user);
    return next();
  }

  // Same Hono inference reason as requireAuth: handlers pass their own
  // route-typed context, not assignable to one fixed Context type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  function currentUser(c: any): AuthUser {
    return c.get("user") as AuthUser;
  }

  // ---- auth ----

  registerMiddleware(app, ctx);

  registerHealth(app, ctx);

  registerAuth(app, ctx);

  // ---- stories ----

  registerStories(app, ctx);

  // ---- actions ----

  registerActions(app, ctx);

  // ---- story cards (basic CRUD; no triggering logic this phase) ----

  registerCards(app, ctx);

  // ---- providers (Phase 2a; api_key_enc never leaves the server) ----

  registerProviders(app, ctx);

  registerProviderOps(app, ctx);

  // ---- generation (SSE) ----
  registerGenerate(app, ctx);

  // ---- scenarios (read-only this phase) ----

  registerScenarios(app, ctx);

  // ---- import / export (Phase 4) ----
  registerExport(app, ctx);

  // (import validation lives in services/import.ts)

  registerImport(app, ctx);

  // ---- scripts (Phase 2b) ----

  registerScripts(app, ctx);

  // ---- compressed ranges (Phase 2c; a view over the action log) ----

  registerRanges(app, ctx);

  // ---- settings (Phase 3) ----

  registerSettings(app, ctx);

  return app;
}
