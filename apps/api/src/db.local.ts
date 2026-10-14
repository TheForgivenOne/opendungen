import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";

// Local-only SQLite client (Node): file-backed DB via better-sqlite3.
// Used by tests (with ":memory:"). Kept in a separate module from db.ts
// so the Cloudflare Worker bundle never includes Node native modules.
// The schema lives in ./db/schema.ts.
export function getLocalDb(filename = "./local.db") {
  const sqlite = new Database(filename);
  // Enforce foreign keys locally, matching D1: cascades (scripts,
  // sessions) and ON DELETE SET NULL (story provider overrides) must
  // behave identically in tests and production.
  (sqlite as unknown as { pragma: (stmt: string) => void }).pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export type LocalDb = ReturnType<typeof getLocalDb>;
