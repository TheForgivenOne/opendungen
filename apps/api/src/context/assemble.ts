// Context assembly: builds the layered message list for one
// turn. Uses only the frozen budget constants from story.ts. No
// tokenizer is shipped — token counts are rough chars/4 estimates by
// design. Fixed wording lives in context/prompts.ts (single source of
// truth); this module decides placement and trimming only.
//
// Layer order (all system except history + input):
//   1 BASE_SYSTEM_PROMPT, 2 OUTPUT_CONSTRAINTS,
//   3 scenario aiInstructions (absent when empty),
//   4 MODE_DIRECTIVES[mode],
//   5 Plot Essentials (absent when empty),
//   6 Story Summary (absent when empty),
//   7 World Lore cards (absent when none trigger),
//   8 recent actions verbatim (input -> user, output/continue ->
//     assistant), oldest first, capped to the history budget, with
//     compressed ranges substituted for the actions they cover,
//   9 Author's Note (absent when memory is empty),
//   10 the new player input, formatted by mode (absent on continue).
//
// Budgets (total 8192): the required layer (base + constraints +
// scenario + mode + plot + summary + memory) must fit 70%. On
// overflow, trim story cards -> memory -> summary (floor 100 tokens)
// -> plot essentials. Never trim base, constraints, scenario
// instructions, the mode directive, or the last action. The dynamic
// 30% splits cards 25% / history 50% / memory 25%. Actions covered by
// an active compressed range are replaced by one synthetic assistant
// message at the outermost range's startIdx position; restored ranges
// (per-turn restoreRangeIds) keep their actions verbatim instead.

import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HISTORY_KEEP_LAST_N,
  type ContextBudget,
} from "@opendungen/shared";
import type { LLMMessage } from "../llm/types";
import {
  BASE_SYSTEM_PROMPT,
  MODE_DIRECTIVES,
  OUTPUT_CONSTRAINTS,
  authorsNote,
  type TurnMode,
} from "./prompts";

export type { TurnMode };

export interface AssembleCards {
  id: string;
  keys: string[];
  entry: string;
  enabled: boolean;
}

export interface AssembleAction {
  idx: number;
  type: string;
  text: string;
}

export interface AssembleStory {
  aiInstructions: string;
  plotEssentials: string;
  summary: string;
  memory: string;
}

export interface AssembleRange {
  id: string;
  startIdx: number;
  endIdx: number;
  summary: string;
}

export interface AppliedRange {
  id: string;
  startIdx: number;
  endIdx: number;
}

export interface AssembleInput {
  story: AssembleStory;
  actions: AssembleAction[];
  cards: AssembleCards[];
  // The turn kind: selects the Layer 4 directive and formats the
  // trailing input. "continue" omits the final user message.
  mode: TurnMode;
  // Absent on continue turns: history alone forms the prompt and no
  // trailing user message is appended.
  newInput?: string;
  tokenMultiplier: number;
  budget?: ContextBudget;
  maxOutputTokens?: number;
  // Compressed ranges covering parts of the log. Covered actions are
  // replaced by one synthetic summary message per outermost range.
  ranges: AssembleRange[];
  // Per-turn restore: these ranges stay suppressed and their actions
  // are included verbatim instead. Never persisted.
  restoreRangeIds?: string[];
}

export interface ContextUsage {
  required: number;
  cards: number;
  history: number;
  total: number;
}

export interface AssembledContext {
  messages: LLMMessage[];
  usage: ContextUsage;
  cardsInjected: string[];
  cachePrefixUpTo: number;
  maxTokens: number;
  // Ranges whose summary messages survived into the history.
  rangesApplied: AppliedRange[];
}

export const SUMMARY_TOKEN_FLOOR = 100;
export const MAX_CARDS_INJECTED = 5;

export function estimateTokens(chars: number, tokenMultiplier: number): number {
  return Math.ceil((chars / 4) * tokenMultiplier);
}

function charsForTokens(tokens: number, tokenMultiplier: number): number {
  return Math.floor((tokens * 4) / tokenMultiplier);
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive whole-word match of any key. Non-word keys (symbols,
// CJK text) fall back to a plain substring match since \b does not apply.
export function cardMatches(keys: string[], haystack: string): boolean {
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\w[\w'’-]*$/u.test(trimmed)) {
      const pattern = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "iu");
      if (pattern.test(haystack)) {
        return true;
      }
    } else if (haystack.toLowerCase().includes(trimmed.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function selectTriggeredCards(
  cards: AssembleCards[],
  actions: AssembleAction[],
  newInput: string,
): AssembleCards[] {
  const recent = [...actions]
    .sort((a, b) => a.idx - b.idx)
    .slice(-HISTORY_KEEP_LAST_N)
    .map((a) => a.text)
    .join("\n");
  const haystack = `${recent}\n${newInput}`;
  const triggered: AssembleCards[] = [];
  for (const card of cards) {
    if (triggered.length >= MAX_CARDS_INJECTED) {
      break;
    }
    if (card.enabled && cardMatches(card.keys, haystack)) {
      triggered.push(card);
    }
  }
  return triggered;
}

function section(title: string, body: string): string {
  return `${title}:\n${body}`;
}

// Layer 10 formatting: do/say inputs arrive already transformed
// (client rule + idempotent server rule) and are marked as player
// turns; story text passes through raw; continue has no input.
function formatInput(mode: TurnMode, text: string): string {
  if (mode === "do" || mode === "say") {
    return `> ${text}`;
  }
  return text;
}

export function assembleContext(input: AssembleInput): AssembledContext {
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET;
  const mult = input.tokenMultiplier;
  const total = budget.totalTokens;
  const requiredCap = Math.floor(total * budget.requiredCapPct);
  const dynamic = total - requiredCap;
  const cardsCap = Math.floor(dynamic * budget.dynamicSplit.cards);
  const historyCap = Math.floor(dynamic * budget.dynamicSplit.history);
  const memoryCap = Math.floor(dynamic * budget.dynamicSplit.memory);
  const summaryFloorChars = charsForTokens(SUMMARY_TOKEN_FLOOR, mult);
  const modeDirective = MODE_DIRECTIVES[input.mode];

  // Triggered cards first: they shape the World Lore message.
  // Cards trim first, by dropping from the end; the audit lists only
  // cards actually injected.
  let triggered = selectTriggeredCards(input.cards, input.actions, input.newInput ?? "");
  while (triggered.length > 0) {
    const text = triggered.map((c) => c.entry).join("\n\n");
    if (estimateTokens(text.length, mult) <= cardsCap) {
      break;
    }
    triggered = triggered.slice(0, -1);
  }
  const cardsInjected = triggered.map((c) => c.id);
  const cardsText = triggered.map((c) => c.entry).join("\n\n");
  const cardsTokens = cardsText ? estimateTokens(cardsText.length, mult) : 0;

  // Memory (the Author's Note) is capped to its dynamic share first...
  let memory = input.story.memory;
  if (estimateTokens(memory.length, mult) > memoryCap) {
    memory = memory.slice(0, charsForTokens(memoryCap, mult));
  }
  let plot = input.story.plotEssentials;
  let summary = input.story.summary;
  const instructions = input.story.aiInstructions;

  // ...then the required layer (base + constraints + scenario + mode
  // + plot + summary + memory) must fit 70%. Trim cards (done above)
  // -> memory -> summary (floor 100t, never to zero) -> plot.
  // Base, constraints, scenario instructions, and the mode directive
  // are never trimmed under any circumstance.
  const requiredTokens = () =>
    estimateTokens(BASE_SYSTEM_PROMPT.length, mult) +
    estimateTokens(OUTPUT_CONSTRAINTS.length, mult) +
    estimateTokens(instructions.length, mult) +
    estimateTokens(modeDirective.length, mult) +
    estimateTokens(plot.length, mult) +
    estimateTokens(summary.length, mult) +
    estimateTokens(memory.length, mult);
  const fit = (text: string, overBy: number): string => {
    const allowed = estimateTokens(text.length, mult) - overBy;
    return text.slice(0, Math.max(0, charsForTokens(allowed, mult)));
  };
  let over = requiredTokens() - requiredCap;
  if (over > 0 && memory) {
    memory = fit(memory, over);
    over = requiredTokens() - requiredCap;
  }
  if (over > 0 && estimateTokens(summary.length, mult) > SUMMARY_TOKEN_FLOOR) {
    const allowed = Math.max(SUMMARY_TOKEN_FLOOR, estimateTokens(summary.length, mult) - over);
    summary = summary.slice(0, Math.max(summaryFloorChars, charsForTokens(allowed, mult)));
    over = requiredTokens() - requiredCap;
  }
  if (over > 0 && plot) {
    plot = fit(plot, over);
  }

  // Layers 1-7: the stable system prefix (cacheable within a story
  // while the mode holds).
  const prefix: LLMMessage[] = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    { role: "system", content: OUTPUT_CONSTRAINTS },
  ];
  if (instructions) {
    prefix.push({ role: "system", content: instructions });
  }
  prefix.push({ role: "system", content: modeDirective });
  if (plot) {
    prefix.push({ role: "system", content: section("Plot Essentials", plot) });
  }
  if (summary) {
    prefix.push({ role: "system", content: section("Story Summary", summary) });
  }
  if (cardsText) {
    prefix.push({ role: "system", content: section("World Lore", cardsText) });
  }
  // The cacheable prefix runs through the last stable system message
  // (cards, else summary, else plot, else the mode directive). The
  // Author's Note and history below are per-turn.
  const cachePrefixUpTo = prefix.length - 1;

  // Compressed ranges: restored ranges stay suppressed; any other
  // range covering an action suppresses it in favour of a synthetic
  // summary message. Nested ranges collapse to the outermost — a
  // parent's summary already incorporates its children — so only
  // ranges contained in no other active range produce a message.
  const restored = new Set(input.restoreRangeIds ?? []);
  const active = input.ranges.filter((r) => !restored.has(r.id));
  const byPosition = [...active].sort(
    (a, b) => a.startIdx - b.startIdx || b.endIdx - a.endIdx || (a.id < b.id ? -1 : 1),
  );
  const outermost: AssembleRange[] = [];
  for (const range of byPosition) {
    const shadowed = outermost.some(
      (o) => o.startIdx <= range.startIdx && o.endIdx >= range.endIdx,
    );
    if (!shadowed) {
      outermost.push(range);
    }
  }
  const covered = (idx: number) => outermost.some((o) => idx >= o.startIdx && idx <= o.endIdx);

  // Candidate history items in idx order: one synthetic message per
  // outermost range at its startIdx, plus every uncovered action.
  // Newest-first fill within the history budget, then oldest-first —
  // except the newest item is never trimmed (the last action always
  // ships, even if it alone exceeds the cap).
  const ordered = [...input.actions].sort((a, b) => a.idx - b.idx);
  const items: { idx: number; message: LLMMessage; rangeId?: string }[] = [];
  for (const range of outermost) {
    items.push({
      idx: range.startIdx,
      message: {
        role: "assistant",
        content: `[summary of idx ${range.startIdx}–${range.endIdx}]: ${range.summary}`,
      },
      rangeId: range.id,
    });
  }
  for (const action of ordered) {
    if (covered(action.idx)) {
      continue;
    }
    items.push({
      idx: action.idx,
      message: {
        role: action.type === "input" ? "user" : "assistant",
        content: action.text,
      },
    });
  }
  items.sort((a, b) => a.idx - b.idx);

  const history: LLMMessage[] = [];
  const appliedIds: string[] = [];
  let historyTokens = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const tokens = estimateTokens(item.message.content.length, mult);
    if (historyTokens + tokens > historyCap && history.length > 0) {
      break;
    }
    historyTokens += tokens;
    history.unshift(item.message);
    if (item.rangeId) {
      appliedIds.unshift(item.rangeId);
    }
  }
  const rangesApplied: AppliedRange[] = appliedIds.map((id) => {
    const range = outermost.find((o) => o.id === id);
    return { id, startIdx: range?.startIdx ?? 0, endIdx: range?.endIdx ?? 0 };
  });

  // Layer 9 (Author's Note, after history) + Layer 10 (input).
  // Continue turns end on history: no trailing user message at all.
  const messages: LLMMessage[] = [...prefix, ...history];
  if (input.mode !== "continue" && input.newInput !== undefined) {
    if (memory) {
      messages.push({ role: "system", content: authorsNote(memory) });
    }
    messages.push({ role: "user", content: formatInput(input.mode, input.newInput) });
  }

  const required = requiredTokens();
  const totalTokens = estimateTokens(
    messages.reduce((n, m) => n + m.content.length, 0),
    mult,
  );
  return {
    messages,
    usage: { required, cards: cardsTokens, history: historyTokens, total: totalTokens },
    rangesApplied,
    cardsInjected,
    cachePrefixUpTo,
    maxTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
