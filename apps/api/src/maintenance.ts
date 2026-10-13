// Data maintenance: cheap invariant sweeps with no cron. Self-hosters
// call POST /api/admin/cleanup from their own scheduler (see README).

import { sql } from "drizzle-orm";
import type { AppDb } from "./app";

export interface CleanupCounts {
  sessions: number;
  rateLimits: number;
  scriptStates: number;
  compressedRanges: number;
}

export async function cleanup(db: AppDb, now: number = Date.now()): Promise<CleanupCounts> {
  // Deletes use RETURNING + db.all so the deleted-row count works
  // identically on D1 and better-sqlite3.
  const expiredSessions = await db.all<{ id: string }>(
    sql`delete from sessions where expires_at < ${now} returning id`,
  );
  const staleLimits = await db.all<{ key: string }>(
    sql`delete from rate_limits where window_start < ${now - 120000} returning key`,
  );
  const orphanStates = await db.all<{ script_id: string }>(
    sql`delete from script_states where script_id not in (select id from scripts) returning script_id`,
  );
  const badRanges = await db.all<{ id: string }>(
    sql`delete from compressed_ranges where start_idx >= end_idx returning id`,
  );
  return {
    sessions: expiredSessions.length,
    rateLimits: staleLimits.length,
    scriptStates: orphanStates.length,
    compressedRanges: badRanges.length,
  };
}
