import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getLocalDb } from "./db.local";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const EXPECTED_TABLES = [
  "users",
  "sessions",
  "provider_configs",
  "scenarios",
  "stories",
  "actions",
  "story_cards",
  "compressed_ranges",
  "rate_limits",
  "scripts",
  "script_states",
];

const EXPECTED_INDEXES = [
  "actions_story_id_idx_idx",
  "compressed_ranges_story_id_range_idx",
  "story_cards_story_id_idx",
  "sessions_user_id_idx",
  "provider_configs_user_id_idx",
  "stories_user_id_deleted_at_idx",
  "scripts_story_id_position_idx",
  "scripts_scenario_id_position_idx",
];

describe("schema migrations", () => {
  it("creates all tables and indexes on a fresh database", () => {
    const db = getLocalDb(":memory:");
    migrate(db, { migrationsFolder: "./drizzle" });

    const tables = db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' order by name`,
    );
    const names = tables.map((t) => t.name);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }

    const indexes = db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'index' order by name`,
    );
    const indexNames = indexes.map((i) => i.name);
    for (const index of EXPECTED_INDEXES) {
      expect(indexNames).toContain(index);
    }
  });

  it("enforces exactly one script owner via CHECK", () => {
    const db = getLocalDb(":memory:");
    migrate(db, { migrationsFolder: "./drizzle" });
    // Need a story to reference; create a minimal user+story.
    // (The builtin scenarios come from the seed migration.)
    db.run(sql`insert into users (id, email, created_at) values ('u1', 'u1@x.y', 1)`);
    db.run(
      sql`insert into stories (id, user_id, title, created_at, updated_at) values ('s1', 'u1', 'T', 1, 1)`,
    );
    // Story-owned script: fine.
    db.run(
      sql`insert into scripts (id, story_id, scenario_id, name, source, created_at) values ('ok1', 's1', null, 'N', 'text;', 1)`,
    );
    // Both owners: rejected.
    expect(() =>
      db.run(
        sql`insert into scripts (id, story_id, scenario_id, name, source, created_at) values ('bad1', 's1', 'builtin-fantasy-waystation', 'N', 'text;', 1)`,
      ),
    ).toThrow();
    // Neither owner: rejected.
    expect(() =>
      db.run(
        sql`insert into scripts (id, story_id, scenario_id, name, source, created_at) values ('bad2', null, null, 'N', 'text;', 1)`,
      ),
    ).toThrow();
  });

  it("seeds the three builtin scenarios", () => {
    const db = getLocalDb(":memory:");
    migrate(db, { migrationsFolder: "./drizzle" });
    const rows = db.all<{ id: string; builtin: number }>(
      sql`select id, builtin from scenarios order by id`,
    );
    expect(rows).toEqual([
      { id: "builtin-fantasy-waystation", builtin: 1 },
      { id: "builtin-mystery-hollow-creek", builtin: 1 },
      { id: "builtin-scifi-derelict", builtin: 1 },
    ]);
  });
});
