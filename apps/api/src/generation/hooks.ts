// Hook wiring. Each hook runs the ordered scripts through
// the QuickJS sandbox and returns the rewritten value plus per-script
// errors and changed states (for the pipeline to persist).
//
// Signatures: (story, actions, value, scripts, states, opts?).
// - runInputHook: rewrites the player input text before assembly.
// - runContextHook: rewrites the context layers BEFORE assembly, so
//   cachePrefixUpTo and the token audit reflect the scripted values.
//   Card edits apply by position to the triggered cards' entries;
//   scripts cannot add, remove, or re-key cards.
// - runOutputHook: rewrites the full output AFTER streaming. It runs
//   only on success (never on abort); see ARCHITECTURE.md for the
//   streamed-vs-persisted distinction.

import { selectTriggeredCards, type AssembleCards } from "../context/assemble";
import { runHook } from "../scripts/runner";
import type { ContextPayload, HookScript, ScriptErrorInfo } from "../scripts/types";
import { loadScriptStates, saveScriptStates } from "../scripts/state";

export interface HookAction {
  idx: number;
  type: string;
  text: string;
}

export interface HookStory {
  id: string;
}

export interface HookOptions {
  seed?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  logger?: (message: string) => void;
}

export interface InputHookResult {
  text: string;
  errors: ScriptErrorInfo[];
  updatedStates: Map<string, string>;
}

export interface ContextHookResult {
  story: {
    aiInstructions: string;
    plotEssentials: string;
    summary: string;
    memory: string;
  };
  cards: AssembleCards[];
  errors: ScriptErrorInfo[];
  updatedStates: Map<string, string>;
}

export interface OutputHookResult {
  text: string;
  errors: ScriptErrorInfo[];
  updatedStates: Map<string, string>;
}

export type { HookScript };

function historyOf(actions: HookAction[]): { type: string; text: string }[] {
  return [...actions]
    .sort((a, b) => a.idx - b.idx)
    .slice(-10)
    .map((a) => ({ type: a.type, text: a.text }));
}

function nextIdx(actions: HookAction[]): number {
  let max = -1;
  for (const action of actions) {
    if (action.idx > max) {
      max = action.idx;
    }
  }
  return max + 1;
}

export async function runInputHook(
  story: HookStory,
  actions: HookAction[],
  input: string,
  scripts: HookScript[],
  states: Map<string, unknown>,
  opts: HookOptions = {},
): Promise<InputHookResult> {
  if (scripts.length === 0) {
    return { text: input, errors: [], updatedStates: new Map() };
  }
  const result = await runHook({
    hook: "input",
    scripts,
    states,
    payload: { text: input },
    history: historyOf(actions),
    seed: opts.seed ?? `${story.id}:${nextIdx(actions)}:input`,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    logger: opts.logger,
  });
  return { text: result.value.text, errors: result.errors, updatedStates: result.updatedStates };
}

export async function runContextHook(
  story: HookStory,
  actions: HookAction[],
  layers: {
    instructions: string;
    plotEssentials: string;
    summary: string;
    memory: string;
    cards: AssembleCards[];
    newInput: string;
  },
  scripts: HookScript[],
  states: Map<string, unknown>,
  opts: HookOptions = {},
): Promise<ContextHookResult> {
  if (scripts.length === 0) {
    return {
      story: {
        aiInstructions: layers.instructions,
        plotEssentials: layers.plotEssentials,
        summary: layers.summary,
        memory: layers.memory,
      },
      cards: layers.cards,
      errors: [],
      updatedStates: new Map(),
    };
  }
  // The payload carries the triggered cards' entries; edits map back
  // by position onto the same triggered cards.
  const triggered = selectTriggeredCards(layers.cards, actions, layers.newInput);
  const payload: ContextPayload = {
    instructions: layers.instructions,
    plotEssentials: layers.plotEssentials,
    summary: layers.summary,
    memory: layers.memory,
    cards: triggered.map((card) => card.entry),
  };
  const result = await runHook({
    hook: "context",
    scripts,
    states,
    payload,
    history: historyOf(actions),
    seed: opts.seed ?? `${story.id}:${nextIdx(actions)}:context`,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    logger: opts.logger,
  });
  const edited = result.value.cards;
  const cards =
    edited.length === triggered.length
      ? layers.cards.map((card) => {
          const position = triggered.findIndex((t) => t.id === card.id);
          return position >= 0 ? { ...card, entry: edited[position] } : card;
        })
      : layers.cards;
  return {
    story: {
      aiInstructions: result.value.instructions,
      plotEssentials: result.value.plotEssentials,
      summary: result.value.summary,
      memory: result.value.memory,
    },
    cards,
    errors: result.errors,
    updatedStates: result.updatedStates,
  };
}

export async function runOutputHook(
  story: HookStory,
  actions: HookAction[],
  output: string,
  scripts: HookScript[],
  states: Map<string, unknown>,
  opts: HookOptions = {},
): Promise<OutputHookResult> {
  if (scripts.length === 0) {
    return { text: output, errors: [], updatedStates: new Map() };
  }
  const result = await runHook({
    hook: "output",
    scripts,
    states,
    payload: { text: output },
    history: historyOf(actions),
    seed: opts.seed ?? `${story.id}:${nextIdx(actions)}:output`,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    logger: opts.logger,
  });
  return { text: result.value.text, errors: result.errors, updatedStates: result.updatedStates };
}

// Loads ordered, enabled scripts for a turn: scenario scripts in
// position order first, then story scripts in position order.
export interface OrderedHookScript extends HookScript {
  position: number;
}

export function orderScripts(
  scenarioScripts: OrderedHookScript[],
  storyScripts: OrderedHookScript[],
): HookScript[] {
  const byPosition = (a: OrderedHookScript, b: OrderedHookScript) =>
    a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...[...scenarioScripts].sort(byPosition), ...[...storyScripts].sort(byPosition)];
}

export { loadScriptStates, saveScriptStates };
