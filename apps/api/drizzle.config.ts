import { defineConfig } from "drizzle-kit";

// Phase 1 schema lives at `./src/db/schema.ts`.
// Local dev uses a file-backed SQLite DB via better-sqlite3
// (see `./src/db.local.ts`); production uses the Cloudflare D1 binding
// named DB (see `wrangler.toml`).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
