import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export interface WorkerEnv {
  DB?: AnyD1Database;
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

// Production SQLite client (Cloudflare Workers). Uses the D1 binding named
// DB from wrangler.toml. The Phase 1 schema lives in ./db/schema.ts and is
// applied with `wrangler d1 migrations apply DB` (local: `--local`).
export function getDb(env: WorkerEnv) {
  if (!env.DB) {
    throw new Error("Missing D1 binding DB (local dev uses the simulated D1 binding).");
  }
  return drizzle(env.DB, { schema });
}

export type WorkerDb = ReturnType<typeof getDb>;
