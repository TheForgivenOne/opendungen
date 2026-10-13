// Import validation: structural checks for versioned backup files.
// Pure functions over unknown input; persistence lives in
// routes/import.ts (applyImportDoc).
import { isProviderKind } from "../llm";

export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 20000000;

export interface ImportSkipped {
  entity: string;
  id?: string;
  reason: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// Structural + in-file FK validation. Returns a normalized doc or a
// human-readable reason (400). Dangling in-file references are
// rejected; references that resolve against live DB rows (scenario
// refs, providers) are remapped or unlinked with reasons at apply.
export function validateImportDoc(
  input: unknown,
): { doc: NormalizedImportDoc } | { reason: string } {
  if (!isRecord(input)) {
    return { reason: "file must contain a JSON object" };
  }
  if (input.opendungen !== EXPORT_VERSION) {
    return { reason: `unsupported export version: expected ${EXPORT_VERSION}` };
  }
  const rawStories = input.stories ?? [];
  const rawScenarios = input.scenarios ?? [];
  const rawProviders = input.providerConfigs ?? [];
  if (!Array.isArray(rawStories) || !Array.isArray(rawScenarios) || !Array.isArray(rawProviders)) {
    return { reason: "stories, scenarios and providerConfigs must be arrays" };
  }
  const storyIds = new Set<string>();
  const scenarioIds = new Set<string>();
  const fullScenarioIds = new Set<string>();
  const providerIds = new Set<string>();
  const scriptIds = new Set<string>();
  const rangeByStory = new Map<string, Set<string>>();
  const fail = (reason: string) => ({ reason });

  for (const entry of rawScenarios) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string") {
      return fail("scenarios: every entry needs string id and title");
    }
    scenarioIds.add(entry.id);
    if ("opening" in entry) {
      if (
        typeof entry.description !== "string" ||
        typeof entry.opening !== "string" ||
        typeof entry.aiInstructions !== "string" ||
        !Array.isArray(entry.tags) ||
        !entry.tags.every((t) => typeof t === "string")
      ) {
        return fail(`scenarios: full entry ${entry.id} has invalid fields`);
      }
      fullScenarioIds.add(entry.id);
    }
  }
  for (const entry of rawProviders) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.kind !== "string" ||
      (entry.baseUrl !== null && typeof entry.baseUrl !== "string") ||
      typeof entry.model !== "string" ||
      typeof entry.isDefault !== "boolean" ||
      typeof entry.createdAt !== "number"
    ) {
      return fail("providerConfigs: every entry needs id/label/kind/model/isDefault");
    }
    if (!isProviderKind(entry.kind)) {
      return fail(`providerConfigs: unknown kind for ${entry.id}`);
    }
    providerIds.add(entry.id);
  }
  const stories: NormalizedImportDoc["stories"] = [];
  for (const bundle of rawStories) {
    if (!isRecord(bundle)) {
      return fail("stories: every entry must be an object");
    }
    const s = bundle.story;
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      typeof s.title !== "string" ||
      typeof s.aiInstructions !== "string" ||
      typeof s.plotEssentials !== "string" ||
      typeof s.memory !== "string" ||
      typeof s.summary !== "string" ||
      (s.scenarioId !== null && typeof s.scenarioId !== "string") ||
      (s.providerId !== null && typeof s.providerId !== "string") ||
      typeof s.createdAt !== "number" ||
      typeof s.updatedAt !== "number"
    ) {
      return fail("stories: story rows need id/title/layers/timestamps");
    }
    for (const field of [
      "compressTriggerPct",
      "compressMaxTokens",
      "compressTemperature",
      "contextTokens",
      "maxOutputTokens",
    ] as const) {
      if (s[field] !== null && s[field] !== undefined && typeof s[field] !== "number") {
        return fail(`stories: ${s.id} has a non-numeric ${field}`);
      }
    }
    if (
      s.completedAt !== null &&
      s.completedAt !== undefined &&
      typeof s.completedAt !== "number"
    ) {
      return fail(`stories: ${s.id} has a non-numeric completedAt`);
    }
    if (s.scenarioId !== null && !scenarioIds.has(s.scenarioId)) {
      return fail(`stories: ${s.id} references unknown scenario ${s.scenarioId}`);
    }
    if (s.providerId !== null && !providerIds.has(s.providerId)) {
      return fail(`stories: ${s.id} references unknown provider ${s.providerId}`);
    }
    const actions = bundle.actions ?? [];
    const cards = bundle.cards ?? [];
    const ranges = bundle.ranges ?? [];
    const bundleScripts = bundle.scripts ?? [];
    const bundleStates = bundle.states ?? [];
    if (
      !Array.isArray(actions) ||
      !Array.isArray(cards) ||
      !Array.isArray(ranges) ||
      !Array.isArray(bundleScripts) ||
      !Array.isArray(bundleStates)
    ) {
      return fail(`stories: ${s.id} bundle arrays must be arrays`);
    }
    const rangeIds = new Set<string>();
    for (const action of actions) {
      if (
        !isRecord(action) ||
        typeof action.id !== "string" ||
        action.storyId !== s.id ||
        !isInt(action.idx) ||
        (action.type !== "input" && action.type !== "output" && action.type !== "continue") ||
        typeof action.text !== "string" ||
        (action.mode !== undefined &&
          action.mode !== null &&
          action.mode !== "do" &&
          action.mode !== "say" &&
          action.mode !== "story") ||
        typeof action.createdAt !== "number"
      ) {
        return fail(`stories: ${s.id} has an invalid action`);
      }
    }
    for (const card of cards) {
      if (
        !isRecord(card) ||
        typeof card.id !== "string" ||
        card.storyId !== s.id ||
        !Array.isArray(card.keys) ||
        !card.keys.every((k) => typeof k === "string") ||
        typeof card.entry !== "string" ||
        typeof card.enabled !== "boolean"
      ) {
        return fail(`stories: ${s.id} has an invalid card`);
      }
    }
    for (const range of ranges) {
      if (
        !isRecord(range) ||
        typeof range.id !== "string" ||
        range.storyId !== s.id ||
        !isInt(range.startIdx) ||
        !isInt(range.endIdx) ||
        typeof range.summary !== "string" ||
        (range.parentRangeId !== null && typeof range.parentRangeId !== "string") ||
        typeof range.createdAt !== "number"
      ) {
        return fail(`stories: ${s.id} has an invalid range`);
      }
      rangeIds.add(range.id);
    }
    for (const range of ranges) {
      const parent = (range as { parentRangeId: string | null }).parentRangeId;
      if (parent !== null && !rangeIds.has(parent)) {
        return fail(
          `stories: ${s.id} range ${String((range as { id: unknown }).id)} has an unknown parent`,
        );
      }
    }
    for (const script of bundleScripts) {
      if (
        !isRecord(script) ||
        typeof script.id !== "string" ||
        typeof script.name !== "string" ||
        typeof script.source !== "string" ||
        typeof script.enabled !== "boolean" ||
        !isInt(script.position) ||
        typeof script.createdAt !== "number" ||
        ((script.storyId ?? null) === null) === ((script.scenarioId ?? null) === null)
      ) {
        return fail(`stories: ${s.id} has an invalid script`);
      }
      if (script.storyId !== null && script.storyId !== undefined && script.storyId !== s.id) {
        return fail(`stories: ${s.id} has a script owned by another story`);
      }
      if (
        script.scenarioId !== null &&
        script.scenarioId !== undefined &&
        !fullScenarioIds.has(script.scenarioId as string)
      ) {
        return fail(`stories: ${s.id} has a script for an unknown scenario`);
      }
      scriptIds.add(script.id as string);
    }
    for (const state of bundleStates) {
      if (
        !isRecord(state) ||
        typeof state.scriptId !== "string" ||
        state.storyId !== s.id ||
        typeof state.state !== "string" ||
        typeof state.updatedAt !== "number"
      ) {
        return fail(`stories: ${s.id} has an invalid script state`);
      }
      if (!scriptIds.has(state.scriptId)) {
        return fail(`stories: ${s.id} has a state for an unknown script`);
      }
    }
    storyIds.add(s.id as string);
    rangeByStory.set(s.id as string, rangeIds);
    stories.push(bundle as unknown as NormalizedImportDoc["stories"][number]);
  }
  const scenarios = rawScenarios as NormalizedImportDoc["scenarios"];
  const providers = rawProviders as NormalizedImportDoc["providerConfigs"];
  return { doc: { stories, scenarios, providerConfigs: providers } };
}

export interface NormalizedImportDoc {
  stories: {
    story: {
      id: string;
      title: string;
      aiInstructions: string;
      plotEssentials: string;
      memory: string;
      summary: string;
      scenarioId: string | null;
      providerId: string | null;
      compressTriggerPct?: number | null;
      compressMaxTokens?: number | null;
      compressTemperature?: number | null;
      contextTokens?: number | null;
      maxOutputTokens?: number | null;
      completedAt?: number | null;
      createdAt: number;
      updatedAt: number;
    };
    actions: {
      id: string;
      idx: number;
      type: "input" | "output" | "continue";
      text: string;
      mode?: string | null;
      createdAt: number;
    }[];
    cards: { id: string; keys: string[]; entry: string; enabled: boolean }[];
    ranges: {
      id: string;
      startIdx: number;
      endIdx: number;
      summary: string;
      parentRangeId: string | null;
      createdAt: number;
    }[];
    scripts: {
      id: string;
      storyId: string | null;
      scenarioId: string | null;
      name: string;
      source: string;
      enabled: boolean;
      position: number;
      createdAt: number;
    }[];
    states: { scriptId: string; state: string; updatedAt: number }[];
  }[];
  scenarios: (
    | {
        id: string;
        title: string;
        description: string;
        opening: string;
        aiInstructions: string;
        tags: string[];
      }
    | { id: string; title: string }
  )[];
  providerConfigs: {
    id: string;
    label: string;
    kind: string;
    baseUrl: string | null;
    model: string;
    isDefault: boolean;
    createdAt: number;
  }[];
}

export function inOverrideRange(field: string, value: number | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (field) {
    case "compressTriggerPct":
      return value >= 0.3 && value <= 0.95;
    case "compressMaxTokens":
      return Number.isInteger(value) && value >= 200 && value <= 2000;
    case "compressTemperature":
      return value >= 0 && value <= 1;
    case "contextTokens":
      return Number.isInteger(value) && value >= 2048 && value <= 200000;
    case "maxOutputTokens":
      return Number.isInteger(value) && value >= 100 && value <= 4000;
    default:
      return false;
  }
}
