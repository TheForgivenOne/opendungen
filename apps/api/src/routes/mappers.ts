// Row mappers: snake_case Drizzle rows become camelCase API JSON.
// Timestamps stay integer ms; booleans stored as 0/1 become booleans.

import type { AuthUser } from "../app";
import {
  actions,
  compressedRanges,
  providerConfigs,
  scenarios,
  scripts,
  stories,
  storyCards,
  users,
} from "../db/schema";

export type StoryRow = typeof stories.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type CardRow = typeof storyCards.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ProviderRow = typeof providerConfigs.$inferSelect;
export type ScriptRow = typeof scripts.$inferSelect;
export type ScenarioRow = typeof scenarios.$inferSelect;
export type RangeRow = typeof compressedRanges.$inferSelect;

export function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    instanceAdmin: row.instanceAdmin === 1,
  };
}

export function toStory(row: StoryRow) {
  return {
    id: row.id,
    userId: row.userId,
    scenarioId: row.scenarioId,
    title: row.title,
    aiInstructions: row.aiInstructions,
    plotEssentials: row.plotEssentials,
    memory: row.memory,
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    // Phase 4: persistent provider override (null = is_default) +
    // nullable context/compressor overrides (null = constants).
    providerId: row.providerId,
    compressTriggerPct: row.compressTriggerPct,
    compressMaxTokens: row.compressMaxTokens,
    compressTemperature: row.compressTemperature,
    contextTokens: row.contextTokens,
    maxOutputTokens: row.maxOutputTokens,
    // Phase 6b: null = playing, non-null = completed.
    completedAt: row.completedAt,
  };
}

export function toAction(row: ActionRow) {
  return {
    id: row.id,
    storyId: row.storyId,
    idx: row.idx,
    type: row.type,
    text: row.text,
    mode: row.mode,
    createdAt: row.createdAt,
  };
}

export function toCard(row: CardRow) {
  return {
    id: row.id,
    storyId: row.storyId,
    keys: JSON.parse(row.keys) as string[],
    entry: row.entry,
    enabled: row.enabled === 1,
  };
}

export function toScenarioListItem(row: ScenarioRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    builtin: row.builtin === 1,
  };
}

export function toScenarioDetail(row: ScenarioRow) {
  return {
    ...toScenarioListItem(row),
    opening: row.opening,
    aiInstructions: row.aiInstructions,
  };
}

export function toRange(row: RangeRow, orderedActions: { idx: number }[]) {
  return {
    id: row.id,
    startIdx: row.startIdx,
    endIdx: row.endIdx,
    summary: row.summary,
    parentRangeId: row.parentRangeId,
    createdAt: row.createdAt,
    actionCount: orderedActions.filter((a) => a.idx >= row.startIdx && a.idx <= row.endIdx).length,
  };
}

export function toScript(row: ScriptRow) {
  return {
    id: row.id,
    storyId: row.storyId,
    scenarioId: row.scenarioId,
    name: row.name,
    source: row.source,
    enabled: row.enabled === 1,
    position: row.position,
    createdAt: row.createdAt,
  };
}
