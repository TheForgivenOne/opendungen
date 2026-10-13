---
name: opendungen-db
description: OpenDungen database rules — Drizzle migrations, dual
  driver (D1 and better-sqlite3), schema conventions. Use when
  adding or changing a database column, table, index, or migration.
---

# OpenDungen Database Rules

## Dual driver
- Production: Cloudflare D1 (SQLite).
- Local dev and tests: better-sqlite3 (SQLite).
- ORM: Drizzle. One schema, two drivers.

The driver union breaks .select(field) overloads. Use raw SQL via
db.all(sql`...`) with manual mapping for hot paths (the actions
table).

## Migrations
- One migration per schema change. Never batch unrelated changes.
- Generate with `pnpm --filter api db:generate`.
- Never edit an applied migration.
- Verify every migration applies cleanly to a fresh D1.
- New columns must be nullable OR have a server-side default.

## Schema conventions
- Primary keys: TEXT (ULID or UUID).
- Timestamps: INTEGER (unix milliseconds).
- Booleans: INTEGER 0/1.
- Foreign keys: always declare ON DELETE behavior.
- Indexes: add for every foreign key and every WHERE-clause column
  on a large table.

## Soft delete
Stories use deleted_at INTEGER (null = active). Queries filter
WHERE deleted_at IS NULL unless explicitly including deleted.
