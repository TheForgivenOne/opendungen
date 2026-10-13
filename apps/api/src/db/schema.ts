import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// Schema, plus script tables. Tables that have no API/UI
// yet (compressed_ranges, rate_limits) are schema-only.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  // scrypt hash; null when no password is set.
  passwordHash: text("password_hash"),
  instanceAdmin: integer("instance_admin").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// Schema only this phase; no API, no UI.
export const providerConfigs = sqliteTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    // 'openai' | 'anthropic' | 'ollama' | 'openai-compatible'
    kind: text("kind").notNull(),
    baseUrl: text("base_url"),
    model: text("model").notNull(),
    apiKeyEnc: text("api_key_enc").notNull(),
    isDefault: integer("is_default").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    // Per-provider timeouts, null = defaults (60s TTFT,
    // 180s total). Validated to 1000–600000 ms on write.
    ttftTimeoutMs: integer("ttft_timeout_ms"),
    totalTimeoutMs: integer("total_timeout_ms"),
    // JSON object of extra HTTP headers, honored only by the
    // openai-compatible adapter. Nullable; never returned by GET.
    customHeaders: text("custom_headers"),
  },
  (t) => [index("provider_configs_user_id_idx").on(t.userId)],
);

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  opening: text("opening").notNull(),
  aiInstructions: text("ai_instructions").notNull(),
  // JSON array of tags.
  tags: text("tags").notNull(),
  builtin: integer("builtin").notNull().default(0),
  // Null = builtin (read-only). Non-null = user-owned (editable).
  userId: text("user_id").references(() => users.id),
});

export const stories = sqliteTable(
  "stories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").references(() => scenarios.id),
    title: text("title").notNull(),
    aiInstructions: text("ai_instructions").notNull().default(""),
    plotEssentials: text("plot_essentials").notNull().default(""),
    memory: text("memory").notNull().default(""),
    summary: text("summary").notNull().default(""),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Persistent per-story provider override (null = is_default).
    // ON DELETE SET NULL reverts the story when the provider is gone.
    providerId: text("provider_id").references(() => providerConfigs.id, {
      onDelete: "set null",
    }),
    // Nullable per-story overrides; null falls back to the constants.
    compressTriggerPct: real("compress_trigger_pct"),
    compressMaxTokens: integer("compress_max_tokens"),
    compressTemperature: real("compress_temperature"),
    contextTokens: integer("context_tokens"),
    maxOutputTokens: integer("max_output_tokens"),
    // Null = playing, non-null (unix ms) = completed.
    completedAt: integer("completed_at"),
  },
  (t) => [index("stories_user_id_deleted_at_idx").on(t.userId, t.deletedAt)],
);

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    // 'input' | 'output' | 'continue'
    type: text("type").notNull(),
    text: text("text").notNull(),
    // Player input mode ('do' | 'say' | 'story');
    // NULL means AI output (or pre-Phase-6 rows).
    mode: text("mode"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("actions_story_id_idx_idx").on(t.storyId, t.idx),
    unique("actions_story_id_idx_unique").on(t.storyId, t.idx),
  ],
);

export const storyCards = sqliteTable(
  "story_cards",
  {
    id: text("id").primaryKey(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    // JSON array of trigger keywords.
    keys: text("keys").notNull(),
    entry: text("entry").notNull(),
    enabled: integer("enabled").notNull().default(1),
  },
  (t) => [index("story_cards_story_id_idx").on(t.storyId)],
);

// User scripts attached to exactly one of a story or a scenario.
export const scripts = sqliteTable(
  "scripts",
  {
    id: text("id").primaryKey(),
    storyId: text("story_id").references(() => stories.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").references(() => scenarios.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // JS source executed in the QuickJS sandbox.
    source: text("source").notNull(),
    enabled: integer("enabled").notNull().default(1),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("scripts_story_id_position_idx").on(t.storyId, t.position),
    index("scripts_scenario_id_position_idx").on(t.scenarioId, t.position),
    // Exactly one owner: a story script or a scenario script, never both.
    check("scripts_single_owner", sql`(${t.storyId} IS NULL) <> (${t.scenarioId} IS NULL)`),
  ],
);

// Per-script, per-story persisted state (JSON).
export const scriptStates = sqliteTable(
  "script_states",
  {
    scriptId: text("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("{}"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scriptId, t.storyId] })],
);

// Schema only this phase; no logic.
export const compressedRanges = sqliteTable(
  "compressed_ranges",
  {
    id: text("id").primaryKey(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    startIdx: integer("start_idx").notNull(),
    endIdx: integer("end_idx").notNull(),
    summary: text("summary").notNull(),
    parentRangeId: text("parent_range_id").references((): AnySQLiteColumn => compressedRanges.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("compressed_ranges_story_id_range_idx").on(t.storyId, t.startIdx, t.endIdx)],
);

// Schema only this phase; no logic.
export const rateLimits = sqliteTable("rate_limits", {
  // IP address or user id.
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});
