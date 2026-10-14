// Node.js entry point for non-Cloudflare self-hosting.
// Imports the same Hono app as the Worker entry, backed by the local
// better-sqlite3 driver, served via @hono/node-server.
//
//   DB_DRIVER=local DB_PATH=/var/lib/opendungen/db.sqlite \
//     SESSION_SECRET=<random 32 bytes> RUN_MIGRATIONS_ON_BOOT=true \
//     node apps/api/dist/node.js
//
// Only DB_PATH (default ./local.db, relative to the API package) and
// SESSION_SECRET matter here; every other knob mirrors the Worker env
// names (AUTH_MODE, PORT, RATE_LIMIT_ENABLED,
// ALLOW_PRIVATE_PROVIDER_URLS, CORS_ORIGINS, LOG_LEVEL,
// INSTANCE_SCRIPTS_ENABLED).

import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createApp, type AppEnv, type AuthMode } from "./app";
import { getLocalDb } from "./db.local";
import { log } from "./log";

export interface NodeServerOptions {
  port: number;
  authMode: AuthMode;
  sessionSecret: string;
  dbPath: string;
  runMigrations: boolean;
  env?: Partial<AppEnv>;
  // Skip the startup log line (tests).
  quiet?: boolean;
}

function readAuthMode(raw: string | undefined): AuthMode {
  if (raw === "none" || raw === "single" || raw === "multi") {
    return raw;
  }
  return "single";
}

function readEnv(source: NodeJS.ProcessEnv): AppEnv {
  return {
    rateLimitEnabled: source.RATE_LIMIT_ENABLED !== "false",
    allowPrivateProviderUrls: source.ALLOW_PRIVATE_PROVIDER_URLS === "true",
    corsOrigins: (source.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    logLevel: source.LOG_LEVEL ?? "info",
    sentryDsn: source.SENTRY_DSN ?? "",
    scriptsEnabled: source.INSTANCE_SCRIPTS_ENABLED !== "false",
    isProduction: source.NODE_ENV === "production",
  };
}

function migrationsFolder(): string {
  // ./drizzle next to the package, from both src/ (tests) and dist/
  // (built server): both sit one level below the package root.
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export function startNodeServer(options: NodeServerOptions): ServerType {
  const db = getLocalDb(options.dbPath);
  if (options.runMigrations) {
    migrate(db, { migrationsFolder: migrationsFolder() });
  }
  const app = createApp({
    db,
    authMode: options.authMode,
    sessionSecret: options.sessionSecret,
    env: options.env,
  });
  const server = serve({ fetch: app.fetch, port: options.port }, (info) => {
    if (!options.quiet) {
      log.info("node server listening", { port: info.port });
    }
  });
  // Exit cleanly on SIGTERM/SIGINT: drop connections (including
  // long-lived SSE streams), stop accepting, then let the loop drain
  // so the process quits 0. Idempotent: test runners may deliver
  // signals after the server already closed.
  const closable = server as unknown as {
    listening: boolean;
    closeAllConnections?: () => void;
    close(cb: (err?: Error) => void): void;
  };
  const shutdown = (signal: string) => () => {
    if (!closable.listening) {
      return;
    }
    try {
      closable.closeAllConnections?.();
    } catch {
      // Fall through to close() without connection draining.
    }
    closable.close((err) => {
      if (err) {
        log.error("node server close failed", { error: String(err) });
        process.exitCode = 1;
        return;
      }
      if (!options.quiet) {
        log.info("node server stopped", { signal });
      }
    });
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
  return server;
}

export function optionsFromProcessEnv(source: NodeJS.ProcessEnv = process.env): {
  options: NodeServerOptions;
  error: string | null;
} {
  const sessionSecret = source.SESSION_SECRET ?? "";
  if (!sessionSecret) {
    return {
      options: {
        port: 8787,
        authMode: "single",
        sessionSecret: "",
        dbPath: "unused",
        runMigrations: false,
      },
      error: "Missing SESSION_SECRET (set it to a long random string).",
    };
  }
  return {
    options: {
      port: Number(source.PORT ?? 8787),
      authMode: readAuthMode(source.AUTH_MODE),
      sessionSecret,
      dbPath: source.DB_PATH ?? "./local.db",
      runMigrations: source.RUN_MIGRATIONS_ON_BOOT === "true",
      env: readEnv(source),
    },
    error: null,
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === new URL(`file://${entry}`).href;
}

if (isMainModule()) {
  const { options, error } = optionsFromProcessEnv();
  if (error) {
    log.error(error);
    process.exit(1);
  }
  startNodeServer(options);
}
