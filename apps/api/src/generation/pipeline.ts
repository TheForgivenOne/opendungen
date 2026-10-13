// Generation pipeline: assemble context, stream the provider, persist
// the turn. Final store state per outcome:
//   success: input at idx N + output at idx N+1.
//   abort:   input at idx N only; partial output is dropped.
//   error:   input at idx N only; no output (the typed input is kept so
//            the user can retry the same turn).
//   empty:    the provider streamed zero output tokens twice (initial +
//            one retry): input at idx N only, no output, and an
//            `empty_completion` error surfaces to the client.
// The retry path passes reuseInputActionId so the existing input action
// is reused instead of inserting a duplicate.

import {
  type AppliedRange,
  type AssembleAction,
  type AssembleCards,
  type AssembleRange,
  type AssembleStory,
  type ContextUsage,
  type TurnMode,
} from "../context/assemble";
import type { ContextBudget } from "@opendungen/shared";
import { assembleContext } from "../context/assemble";
import { runContextHook, runInputHook, saveScriptStates, type HookScript } from "./hooks";
import { persistInputAction, persistOutputTurn, touchStory } from "./persist";
import type { ScriptErrorInfo } from "../scripts/types";
import type { AppDb } from "../app";
import { withRetry } from "../llm/retry";
import {
  AbortError,
  ProviderError,
  isAbortError,
  providerErrorMessage,
  type LLMChunk,
  type LLMProvider,
  type LLMRequest,
  type LLMTokenUsage,
} from "../llm/types";

export const DEFAULT_TEMPERATURE = 0.7;
// Per-provider timeouts when the row leaves them null: 60s to first
// chunk (TTFT), 180s for the whole turn.
export const DEFAULT_TTFT_TIMEOUT_MS = 60000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 180000;

export interface PipelineAction extends AssembleAction {
  id: string;
}

export interface GenerateTurnParams {
  db: AppDb;
  storyId: string;
  story: AssembleStory;
  actions: PipelineAction[];
  cards: AssembleCards[];
  // Absent on continue turns (no new player input).
  userInput?: string;
  // Turn kind: selects the Layer 4 mode directive and formats the
  // trailing input. Defaults to "story" (the server default when the
  // request omits a mode); retry callers pass the stored input mode.
  mode?: TurnMode;
  // Continue turns: skip the input-hook and the input action,
  // generate from context, and persist only the output.
  skipInput?: boolean;
  // Player input mode stored on the new input row (null = default
  // 'story' path omitted the field; retry reuses the existing row).
  inputMode?: string | null;
  provider: LLMProvider;
  signal: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  // Per-story context budget override (null fields = constants).
  budget?: ContextBudget;
  // Per-story compressor overrides (undefined = constants).
  compressorMaxTokens?: number;
  compressorTemperature?: number;
  // Effective per-provider timeouts (null = defaults above).
  ttftTimeoutMs?: number | null;
  totalTimeoutMs?: number | null;
  // Retry path: the input action already exists; reuse it.
  reuseInputActionId?: string | null;
  // Ordered scripts (scenario first, then story) + loaded states.
  // Empty by default: turns without scripts behave as before.
  scripts?: HookScript[];
  scriptStates?: Map<string, unknown>;
  // Compressed ranges covering the log + per-turn restore ids.
  // Empty by default: turns without ranges behave as before.
  ranges?: AssembleRange[];
  restoreRangeIds?: string[];
}

export interface GenerateMeta {
  type: "meta";
  usage: ContextUsage;
  cardsInjected: string[];
  rangesApplied: AppliedRange[];
  // Null on continue turns (no input action exists).
  inputActionId: string | null;
}

export interface GenerateDelta {
  type: "delta";
  text: string;
}

export type GenerateEvent = GenerateMeta | GenerateDelta;

export interface TokenUsageResult {
  inputTokens: number;
  outputTokens: number;
  source: "provider" | "estimated";
}

export interface GenerateTurnResult {
  usage: ContextUsage;
  // Real provider usage when the final chunk carried it, else an
  // estimate (assembled input total + output chars/4). Budget decisions
  // always use the estimate — real usage is known only after the turn.
  tokenUsage: TokenUsageResult;
  cardsInjected: string[];
  inputActionId: string | null;
  outputActionId: string;
  scriptErrors: ScriptErrorInfo[];
}

// Drains the provider stream after the first chunk arrived: deltas
// yield through, usage is captured, and aborts surface as errors.
async function* drainDeltas(
  iterator: AsyncIterator<LLMChunk, unknown>,
  first: IteratorResult<LLMChunk, unknown>,
  signal: AbortSignal,
  getTimedOut: () => ProviderError | null,
): AsyncGenerator<GenerateDelta, { output: string; realUsage: LLMTokenUsage | undefined }> {
  let output = "";
  let realUsage: LLMTokenUsage | undefined;
  let next: IteratorResult<LLMChunk, unknown> | undefined = first;
  for (;;) {
    if (signal.aborted) {
      throw getTimedOut() ?? new AbortError();
    }
    if (next.done) {
      break;
    }
    const chunk = next.value;
    if (chunk.usage) {
      realUsage = chunk.usage;
    }
    if (chunk.done) {
      break;
    }
    if (chunk.delta) {
      output += chunk.delta;
      yield { type: "delta", text: chunk.delta };
    }
    try {
      next = await iterator.next();
    } catch (err) {
      throw getTimedOut() ?? err;
    }
  }
  return { output, realUsage };
}

export async function* generateTurn(
  params: GenerateTurnParams,
): AsyncGenerator<GenerateEvent, GenerateTurnResult, void> {
  const { db, storyId, signal } = params;
  const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
  const scripts = params.scripts ?? [];
  const states = new Map(params.scriptStates ?? []);
  const scriptErrors: ScriptErrorInfo[] = [];
  const storyRef = { id: storyId };

  // Input hook rewrites the player text before assembly. State changes
  // persist immediately so later hooks in this turn see them.
  // Continue turns skip the input-hook entirely (there is no input).
  let input = "";
  if (!params.skipInput) {
    const inputHook = await runInputHook(
      storyRef,
      params.actions,
      params.userInput ?? "",
      scripts,
      states,
    );
    input = inputHook.text;
    scriptErrors.push(...inputHook.errors);
    await saveScriptStates(db, storyId, inputHook.updatedStates);
  }

  // Context hook rewrites the layers BEFORE assembly, so the audit and
  // cachePrefixUpTo reflect the scripted values.
  const contextHook = await runContextHook(
    storyRef,
    params.actions,
    {
      instructions: params.story.aiInstructions,
      plotEssentials: params.story.plotEssentials,
      summary: params.story.summary,
      memory: params.story.memory,
      cards: params.cards,
      newInput: input,
    },
    scripts,
    states,
  );
  scriptErrors.push(...contextHook.errors);
  await saveScriptStates(db, storyId, contextHook.updatedStates);

  const assembled = assembleContext({
    story: {
      aiInstructions: contextHook.story.aiInstructions,
      plotEssentials: contextHook.story.plotEssentials,
      summary: contextHook.story.summary,
      memory: contextHook.story.memory,
    },
    actions: params.actions,
    cards: contextHook.cards,
    mode: params.mode ?? "story",
    // Continue turns assemble from history alone: no trailing user
    // message is appended.
    newInput: params.skipInput ? undefined : input,
    tokenMultiplier: params.provider.tokenMultiplier,
    budget: params.budget,
    maxOutputTokens: params.maxOutputTokens,
    ranges: params.ranges ?? [],
    restoreRangeIds: params.restoreRangeIds,
  });

  // The input action is persisted BEFORE the provider call begins (see
  // persistInputAction): the client learns its id in the meta event.
  const { inputActionId, inputIdx } = await persistInputAction(
    db,
    storyId,
    params.actions,
    input,
    params.inputMode,
    params.skipInput,
    params.reuseInputActionId,
  );

  yield {
    type: "meta",
    usage: assembled.usage,
    cardsInjected: assembled.cardsInjected,
    rangesApplied: assembled.rangesApplied,
    inputActionId,
  };

  // Providers that reject multiple system messages get every system
  // block joined into one leading system message (cache breakpoint
  // 0); the history and input order is unchanged.
  let providerMessages = assembled.messages;
  let providerCachePrefix = assembled.cachePrefixUpTo;
  if (!params.provider.supportsMultipleSystemMessages) {
    const systemBlocks = assembled.messages.filter((m) => m.role === "system");
    const rest = assembled.messages.filter((m) => m.role !== "system");
    providerMessages = [
      { role: "system", content: systemBlocks.map((m) => m.content).join("\n\n") },
      ...rest,
    ];
    providerCachePrefix = 0;
  }

  const llmReq: LLMRequest = {
    messages: providerMessages,
    maxTokens: assembled.maxTokens,
    temperature,
    cachePrefixUpTo: providerCachePrefix,
  };
  const ttftMs = params.ttftTimeoutMs ?? DEFAULT_TTFT_TIMEOUT_MS;
  const totalMs = params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  // One signal for the provider call, driven by the caller's abort plus
  // both timeout timers. The timers record which one fired so the
  // resulting abort maps to timeout_ttft/timeout_total, and all three
  // paths run the same cleanup: input persisted, no output.
  const linked = new AbortController();
  let settled = false;
  const onUserAbort = (): void => {
    if (!settled) {
      linked.abort();
    }
  };
  signal.addEventListener("abort", onUserAbort, { once: true });
  if (signal.aborted) {
    // The caller aborted before the first yield was consumed: the
    // listener above never fires for an already-settled signal.
    linked.abort();
  }
  let timedOut: ProviderError | null = null;
  const ttftTimer = setTimeout(() => {
    if (!settled && !timedOut) {
      timedOut = new ProviderError(
        "timeout_ttft",
        `provider sent nothing within ${ttftMs} ms`,
        undefined,
      );
      linked.abort();
    }
  }, ttftMs);
  const totalTimer = setTimeout(() => {
    if (!settled && !timedOut) {
      timedOut = new ProviderError(
        "timeout_total",
        `provider did not finish within ${totalMs} ms`,
        undefined,
      );
      linked.abort();
    }
  }, totalMs);
  for (const timer of [ttftTimer, totalTimer]) {
    // Never hold a Node process open for an idle turn.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  let output = "";
  let realUsage: LLMTokenUsage | undefined;
  try {
    // First-chunk acquisition retries once on 429/5xx. Every attempt
    // builds a fresh iterable; once the first chunk arrives there is no
    // further retry (restarting would discard visible text). An empty
    // (or whitespace-only) completion retries the whole generation
    // exactly once via the same path — nothing was yielded, so the
    // client still sees a single stream. The TTFT timer is not rearmed
    // for the second attempt; the total timer still guards it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const acquired = await withRetry(
        async () => {
          const iterator = params.provider.complete(llmReq, linked.signal)[Symbol.asyncIterator]();
          const first = await iterator.next();
          return { iterator, first };
        },
        { maxRetries: 1, signal: linked.signal },
      ).catch((err: unknown) => {
        throw timedOut ?? err;
      });
      // The first chunk arrived: TTFT is satisfied.
      clearTimeout(ttftTimer);
      const { iterator } = acquired;
      const drained = yield* drainDeltas(iterator, acquired.first, linked.signal, () => timedOut);
      output = drained.output;
      realUsage = drained.realUsage;
      if (output.trim() !== "") {
        break;
      }
    }
    if (output.trim() === "") {
      // Both attempts empty: persist no output row. The input stays
      // persisted so the user can retry the same turn.
      await touchStory(db, storyId);
      throw new ProviderError("empty_completion", "The model returned no output. Try again.");
    }
  } catch (err) {
    if (timedOut) {
      await touchStory(db, storyId);
      throw timedOut;
    }
    if (isAbortError(err, signal) || linked.signal.aborted) {
      // Abort: keep the input action, drop partial output.
      await touchStory(db, storyId);
      throw err instanceof AbortError ? err : new AbortError(providerErrorMessage(err));
    }
    // Error (including mid-stream): the input stays persisted so the
    // turn shows as a lone input the user can retry; no output row.
    await touchStory(db, storyId);
    throw err;
  } finally {
    settled = true;
    clearTimeout(ttftTimer);
    clearTimeout(totalTimer);
    signal.removeEventListener("abort", onUserAbort);
  }

  // Output hook runs only on success (see persistOutputTurn).
  const persisted = await persistOutputTurn({
    db,
    storyId,
    storyRef,
    actions: params.actions,
    output,
    scripts,
    states,
    skipInput: params.skipInput,
    inputIdx,
    assembledUsageTotal: assembled.usage.total,
    tokenMultiplier: params.provider.tokenMultiplier,
    realUsage,
  });
  scriptErrors.push(...persisted.errors);
  return {
    usage: assembled.usage,
    tokenUsage: persisted.tokenUsage,
    cardsInjected: assembled.cardsInjected,
    inputActionId,
    outputActionId: persisted.outputActionId,
    scriptErrors,
  };
}
