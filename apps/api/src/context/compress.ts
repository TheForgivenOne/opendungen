// DCP-style story compression: a separate, non-streamed LLM call that
// decides whether a contiguous range of actions can be collapsed into a
// short summary. Never destructive — the actions table stays the source
// of truth; compressed_ranges is only a view onto it. Compression is
// best-effort: every failure mode returns shouldCompress: false and the
// caller swallows it so a turn never blocks or fails on compression.

import { z } from "zod";
import type { AppDb } from "../app";
import { compressedRanges } from "../db/schema";
import { estimateTokens } from "./assemble";
import { type ContextBudget, DEFAULT_CONTEXT_BUDGET } from "@opendungen/shared";
import type { LLMProvider } from "../llm/types";

// Original to OpenDungen. Used verbatim as the compressor system prompt.
export const COMPRESSOR_SYSTEM_PROMPT = `You are a story compression engine. Your job is to decide whether a
contiguous range of story actions can be collapsed into a short
summary without losing narrative information, and if so, to produce
that summary.

Rules:
- Only compress a contiguous range that represents a completed arc:
  a location the player has left, a conversation that has ended, a
  conflict that has resolved.
- Never compress the last 3 actions.
- Never compress an action whose idx is already inside an existing
  range. Instead, extend the range to include it — the new summary
  must incorporate the old summary's content.
- Preserve: named entities, items gained or lost, locations,
  relationships, unresolved threads, and anything the player
  explicitly stated.
- Omit: weather, filler dialogue, repeated travel, restatements,
  sensory description.
- Aim for roughly 1 summary token per 10 original tokens.

Respond with strict JSON only, no prose:
  {"shouldCompress": true,
   "startIdx": <int>, "endIdx": <int>,
   "summary": "<text>"}
or:
  {"shouldCompress": false}`;

export const COMPRESSOR_MAX_TOKENS = 600;
export const COMPRESSOR_TEMPERATURE = 0.2;
export const COMPRESSOR_DIGEST_TOKEN_CAP = 4000;
export const COMPRESSOR_ACTION_TEXT_CHARS = 200;

export interface CompressionDecision {
  shouldCompress: boolean;
  startIdx?: number;
  endIdx?: number;
  summary?: string;
}

export interface CompressionAction {
  idx: number;
  type: string;
  text: string;
}

export interface ExistingCompressionRange {
  id: string;
  startIdx: number;
  endIdx: number;
  summary: string;
}

export interface AttemptCompressionOpts {
  story: { id: string; title: string };
  actions: CompressionAction[];
  existingRanges: ExistingCompressionRange[];
  provider: LLMProvider;
  signal: AbortSignal;
  // Per-story overrides (undefined = the COMPRESSOR_* constants).
  maxTokens?: number;
  temperature?: number;
}

const decisionSchema = z.object({
  shouldCompress: z.boolean(),
  startIdx: z.number().int().optional(),
  endIdx: z.number().int().optional(),
  summary: z.string().optional(),
});

export function parseCompressionDecision(text: string): CompressionDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { shouldCompress: false };
  }
  const result = decisionSchema.safeParse(parsed);
  if (!result.success || !result.data.shouldCompress) {
    return { shouldCompress: false };
  }
  const { startIdx, endIdx, summary } = result.data;
  if (
    startIdx === undefined ||
    endIdx === undefined ||
    summary === undefined ||
    summary.length === 0
  ) {
    return { shouldCompress: false };
  }
  return { shouldCompress: true, startIdx, endIdx, summary };
}

// Compact digest of the story for the compressor: one line per existing
// range (kept first — ranges keep priority), then one line per raw
// (uncovered) action. Capped at 4000 tokens by dropping the oldest raw
// actions first; ranges are never dropped.
export function buildCompressionDigest(
  story: { title: string },
  actions: CompressionAction[],
  existingRanges: ExistingCompressionRange[],
  tokenMultiplier: number,
): string {
  const orderedRanges = [...existingRanges].sort((a, b) => a.startIdx - b.startIdx);
  const covered = (idx: number) => orderedRanges.some((r) => idx >= r.startIdx && idx <= r.endIdx);
  const raw = [...actions].sort((a, b) => a.idx - b.idx).filter((a) => !covered(a.idx));

  const lines = [`Story: ${story.title}`];
  for (const r of orderedRanges) {
    lines.push(`[range:${r.startIdx}-${r.endIdx}] ${r.summary}`);
  }
  const rawLines = raw.map(
    (a) => `[${a.idx}] ${a.type}: ${a.text.slice(0, COMPRESSOR_ACTION_TEXT_CHARS)}`,
  );
  // Drop oldest raw actions first until the digest fits the cap.
  let drop = 0;
  while (drop < rawLines.length) {
    const candidate = [...lines, ...rawLines.slice(drop)].join("\n");
    if (estimateTokens(candidate.length, tokenMultiplier) <= COMPRESSOR_DIGEST_TOKEN_CAP) {
      break;
    }
    drop++;
  }
  return [...lines, ...rawLines.slice(drop)].join("\n");
}

export async function attemptCompression(
  opts: AttemptCompressionOpts,
): Promise<CompressionDecision> {
  const digest = buildCompressionDigest(
    opts.story,
    opts.actions,
    opts.existingRanges,
    opts.provider.tokenMultiplier,
  );
  let text = "";
  try {
    const stream = opts.provider.complete(
      {
        messages: [
          { role: "system", content: COMPRESSOR_SYSTEM_PROMPT },
          { role: "user", content: digest },
        ],
        maxTokens: opts.maxTokens ?? COMPRESSOR_MAX_TOKENS,
        temperature: opts.temperature ?? COMPRESSOR_TEMPERATURE,
      },
      opts.signal,
    );
    for await (const chunk of stream) {
      if (chunk.done) {
        break;
      }
      text += chunk.delta;
    }
  } catch {
    // Best-effort: provider errors (including abort) mean no compression.
    return { shouldCompress: false };
  }
  return parseCompressionDecision(text);
}

export type RangeValidation =
  { ok: true; parentRangeId: string | null } | { ok: false; reason: string };

// Validates a positive compression decision against the log:
// integer bounds in range, last 3 actions excluded, no partial overlap
// with existing ranges. Full containment nests: a new range containing
// existing ones parents to the outermost contained range; a new range
// inside an existing one parents to its innermost container.
export function validateCompressionRange(
  decision: { startIdx: number; endIdx: number },
  actions: CompressionAction[],
  existingRanges: ExistingCompressionRange[],
): RangeValidation {
  const { startIdx, endIdx } = decision;
  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || startIdx >= endIdx) {
    return { ok: false, reason: "range must satisfy startIdx < endIdx with integer bounds" };
  }
  if (actions.length === 0) {
    return { ok: false, reason: "story has no actions" };
  }
  const minIdx = actions[0].idx;
  const maxIdx = actions[actions.length - 1].idx;
  if (startIdx < minIdx || endIdx > maxIdx) {
    return { ok: false, reason: "range out of bounds" };
  }
  if (endIdx > maxIdx - 3) {
    return { ok: false, reason: "range includes one of the last 3 actions" };
  }
  const containers = existingRanges.filter((r) => r.startIdx <= startIdx && r.endIdx >= endIdx);
  if (containers.length > 0) {
    // Innermost container (largest start, then smallest end).
    const parent = [...containers].sort(
      (a, b) => b.startIdx - a.startIdx || a.endIdx - b.endIdx,
    )[0];
    return { ok: true, parentRangeId: parent.id };
  }
  const contained = existingRanges.filter((r) => startIdx <= r.startIdx && endIdx >= r.endIdx);
  const overlapping = existingRanges.filter((r) => startIdx <= r.endIdx && r.startIdx <= endIdx);
  if (overlapping.length > contained.length) {
    return { ok: false, reason: "range partially overlaps an existing range" };
  }
  if (contained.length > 0) {
    // Outermost contained range (smallest start, then largest end).
    const parent = [...contained].sort((a, b) => a.startIdx - b.startIdx || b.endIdx - a.endIdx)[0];
    return { ok: true, parentRangeId: parent.id };
  }
  return { ok: true, parentRangeId: null };
}

export interface InsertedCompressionRange {
  id: string;
  storyId: string;
  startIdx: number;
  endIdx: number;
  summary: string;
  parentRangeId: string | null;
  createdAt: number;
}

export async function insertCompressedRange(
  db: AppDb,
  storyId: string,
  decision: { startIdx: number; endIdx: number; summary: string },
  parentRangeId: string | null,
): Promise<InsertedCompressionRange> {
  const row = {
    id: crypto.randomUUID(),
    storyId,
    startIdx: decision.startIdx,
    endIdx: decision.endIdx,
    summary: decision.summary,
    parentRangeId,
    createdAt: Date.now(),
  };
  await db.insert(compressedRanges).values(row);
  return row;
}

// Post-turn trigger: compress when the story's estimated size reaches
// the trigger share of the context budget. estimatedTokens(story) is
// the rough cost of the story layers plus the full action log.
export function shouldAttemptCompression(opts: {
  story: { aiInstructions: string; plotEssentials: string; memory: string; summary: string };
  actions: { text: string }[];
  tokenMultiplier: number;
  budget?: ContextBudget;
}): boolean {
  const budget = opts.budget ?? DEFAULT_CONTEXT_BUDGET;
  const layerChars =
    opts.story.aiInstructions.length +
    opts.story.plotEssentials.length +
    opts.story.memory.length +
    opts.story.summary.length;
  const actionChars = opts.actions.reduce((n, a) => n + a.text.length, 0);
  return (
    estimateTokens(layerChars + actionChars, opts.tokenMultiplier) >=
    budget.totalTokens * budget.compressTriggerPct
  );
}
