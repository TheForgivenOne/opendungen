export type ScriptHook = "input" | "context" | "output";

export interface HookScript {
  id: string;
  name: string;
  source: string;
}

export interface ScriptErrorInfo {
  scriptId: string;
  name: string;
  message: string;
}

export interface ScriptResult<T> {
  value: T;
  errors: ScriptErrorInfo[];
  // Script ids whose state changed, mapped to serialized JSON ready to
  // upsert. Scripts whose state exceeds the cap are reported in errors
  // instead, and the old state is kept.
  updatedStates: Map<string, string>;
}

export interface InputPayload {
  text: string;
}

export interface ContextPayload {
  instructions: string;
  plotEssentials: string;
  summary: string;
  memory: string;
  cards: string[];
}

export interface OutputPayload {
  text: string;
}

export interface HistoryEntry {
  type: string;
  text: string;
}

export interface RunHookOptions<T> {
  hook: ScriptHook;
  scripts: HookScript[];
  states: Map<string, unknown>;
  payload: T;
  history?: HistoryEntry[];
  // Deterministic seed for Math.random (storyId + action idx).
  seed?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  // Server debug log sink. Defaults to console.debug; tests inject a
  // capture. Script source and state are never logged here.
  logger?: (message: string) => void;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 200;
export const DEFAULT_HOOK_MEMORY_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
