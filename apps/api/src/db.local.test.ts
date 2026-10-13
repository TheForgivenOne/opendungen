import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getLocalDb } from "./db.local";

describe("local SQLite client (better-sqlite3)", () => {
  it("runs queries against an in-memory file DB", () => {
    const db = getLocalDb(":memory:");
    const rows = db.all<{ one: number }>(sql`select 1 as one`);
    expect(rows).toEqual([{ one: 1 }]);
  });
});
