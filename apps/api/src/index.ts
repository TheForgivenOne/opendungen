import { createApp, type AppEnv, type AuthMode } from "./app";
import { getDb, type WorkerEnv } from "./db";

export interface ApiBindings {
  DB?: unknown;
  AUTH_MODE?: string;
  SESSION_SECRET?: string;
  RATE_LIMIT_ENABLED?: string;
  ALLOW_PRIVATE_PROVIDER_URLS?: string;
  CORS_ORIGINS?: string;
  LOG_LEVEL?: string;
  SENTRY_DSN?: string;
  INSTANCE_SCRIPTS_ENABLED?: string;
  NODE_ENV?: string;
}

function readAuthMode(env: WorkerEnv): AuthMode {
  const mode = env.AUTH_MODE;
  if (mode === "none" || mode === "single" || mode === "multi") {
    return mode;
  }
  return "single";
}

// Optional vars with documented defaults (see wrangler.toml and
// .dev.vars.example). SENTRY_DSN is reserved only — no Sentry SDK
// ships, so nothing reads it yet (see PROGRESS.md).
function readEnv(env: WorkerEnv): AppEnv {
  return {
    rateLimitEnabled: env.RATE_LIMIT_ENABLED !== "false",
    allowPrivateProviderUrls: env.ALLOW_PRIVATE_PROVIDER_URLS === "true",
    corsOrigins: (env.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    logLevel: env.LOG_LEVEL ?? "info",
    sentryDsn: env.SENTRY_DSN ?? "",
    scriptsEnabled: env.INSTANCE_SCRIPTS_ENABLED !== "false",
    isProduction: env.NODE_ENV === "production",
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const authMode = readAuthMode(env);
    if (authMode === "single" && !env.SESSION_SECRET) {
      throw new Error(
        "Missing SESSION_SECRET (set it in .dev.vars locally or as a wrangler secret).",
      );
    }
    const app = createApp({
      db: getDb(env),
      authMode,
      sessionSecret: env.SESSION_SECRET ?? "",
      env: readEnv(env),
    });
    return app.fetch(request, env);
  },
};
