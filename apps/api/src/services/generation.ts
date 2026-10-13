// Generation service: turn context loading, the SSE turn runner,
// and the post-turn compression tail. Route handlers in
// routes/generate.ts stay thin; this module owns the pipeline wiring.
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { AppDb, AppEnv } from "../app";
import { listStoryActions } from "../action-log";
import type { TurnMode } from "../context/assemble";
import {
  attemptCompression,
  insertCompressedRange,
  shouldAttemptCompression,
  validateCompressionRange,
} from "../context/compress";
import { estimateTokens } from "../context/assemble";
import { compressedRanges, scripts, storyCards } from "../db/schema";
import { loadScriptStates, orderScripts } from "../generation/hooks";
import { generateTurn } from "../generation/pipeline";
import {
  AbortError,
  ProviderError,
  isAbortError,
  providerErrorMessage,
  type LLMProvider,
} from "../llm";
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from "@opendungen/shared";
import { log } from "../log";
import { toCard, type ScriptRow, type StoryRow } from "../routes/mappers";
import { liveStory } from "./stories";

// SSE keepalive cadence: a `: keepalive` comment line this often while a
// turn streams, so Cloudflare's idle timeout and intermediate proxies
// never kill a slow generation. SSE clients ignore comment lines.
export const KEEPALIVE_INTERVAL_MS = 15000;

// Once-per-isolate guard: scripts-disabled boot warnings must not live
// in a request closure.
let scriptsDisabledWarningLogged = false;

export interface GenerationDeps {
  db: AppDb;
  env: AppEnv;
}

export async function generationContext(db: AppDb, env: AppEnv, userId: string, storyId: string) {
  const story = await liveStory(db, userId, storyId);
  if (!story) {
    return null;
  }
  const ordered = await listStoryActions(db, story.id);
  const cardRows = await db.select().from(storyCards).where(eq(storyCards.storyId, story.id));
  const hookScripts = await loadHookScripts(db, env, story.id, story.scenarioId);
  const scriptStates = scriptsEnabledForTurn(env)
    ? await loadScriptStates(db, story.id)
    : new Map<string, unknown>();
  const rangeRows = await db
    .select()
    .from(compressedRanges)
    .where(eq(compressedRanges.storyId, story.id));
  return {
    story,
    actions: ordered.map((a) => ({
      id: a.id,
      idx: a.idx,
      type: a.type,
      text: a.text,
      mode: a.mode,
    })),
    cards: cardRows.map(toCard),
    scripts: hookScripts,
    scriptStates,
    ranges: rangeRows.map((r) => ({
      id: r.id,
      startIdx: r.startIdx,
      endIdx: r.endIdx,
      summary: r.summary,
    })),
  };
}

// Every restore id must belong to this story; anything else is a 400.
export function unknownRestoreId(ids: string[], rows: { id: string }[]): string | null {
  for (const id of ids) {
    if (!rows.some((r) => r.id === id)) {
      return id;
    }
  }
  return null;
}

// Post-turn compression tail. Best-effort: every failure is logged
// and swallowed so a turn never blocks or fails on compression. It
// runs after `done`, so it never delays the visible output, and it
// never logs summaries or action text.
// Effective per-story context budget: story overrides fall back to
// the shared constants field by field.
export function storyBudget(story: StoryRow): ContextBudget {
  return {
    ...DEFAULT_CONTEXT_BUDGET,
    totalTokens: story.contextTokens ?? DEFAULT_CONTEXT_BUDGET.totalTokens,
    compressTriggerPct: story.compressTriggerPct ?? DEFAULT_CONTEXT_BUDGET.compressTriggerPct,
  };
}

export async function maybeCompressAfterTurn(
  db: AppDb,
  story: StoryRow,
  provider: LLMProvider,
  signal: AbortSignal,
  requestId?: string,
): Promise<void> {
  try {
    const ordered = await listStoryActions(db, story.id);
    const existing = await db
      .select()
      .from(compressedRanges)
      .where(eq(compressedRanges.storyId, story.id));
    if (
      !shouldAttemptCompression({
        story,
        actions: ordered,
        tokenMultiplier: provider.tokenMultiplier,
        budget: storyBudget(story),
      })
    ) {
      return;
    }
    const decision = await attemptCompression({
      story: { id: story.id, title: story.title },
      actions: ordered,
      existingRanges: existing,
      provider,
      signal,
      maxTokens: story.compressMaxTokens ?? undefined,
      temperature: story.compressTemperature ?? undefined,
    });
    if (
      !decision.shouldCompress ||
      decision.startIdx === undefined ||
      decision.endIdx === undefined ||
      decision.summary === undefined
    ) {
      return;
    }
    const validation = validateCompressionRange(
      { startIdx: decision.startIdx, endIdx: decision.endIdx },
      ordered,
      existing,
    );
    if (!validation.ok) {
      log.debug("compression rejected", {
        storyId: story.id,
        reason: validation.reason,
        requestId: requestId ?? null,
      });
      return;
    }
    const inserted = await insertCompressedRange(
      db,
      story.id,
      { startIdx: decision.startIdx, endIdx: decision.endIdx, summary: decision.summary },
      validation.parentRangeId,
    );
    // Never logs summaries or action text — ids, idxs, and counts only.
    log.debug("compression inserted", {
      storyId: story.id,
      startIdx: inserted.startIdx,
      endIdx: inserted.endIdx,
      summaryTokens: estimateTokens(inserted.summary.length, provider.tokenMultiplier),
      parentRangeId: inserted.parentRangeId,
      requestId: requestId ?? null,
    });
  } catch (err) {
    log.error("compression attempt failed", {
      storyId: story.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
      requestId: requestId ?? null,
    });
  }
}

// INSTANCE_SCRIPTS_ENABLED=false makes scripts a no-op (one warning
// per isolate): turns load no scripts and no states, so generate
// works on deploys whose QuickJS WASM cannot load.
export function scriptsEnabledForTurn(env: AppEnv): boolean {
  if (env.scriptsEnabled) {
    return true;
  }
  if (!scriptsDisabledWarningLogged) {
    scriptsDisabledWarningLogged = true;
    log.warn("INSTANCE_SCRIPTS_ENABLED=false: scripts are disabled; turns run without hooks");
  }
  return false;
}

// Enabled scripts for a turn: scenario scripts in position order,
// then story scripts in position order.
export async function loadHookScripts(
  db: AppDb,
  env: AppEnv,
  storyId: string,
  scenarioId: string | null,
) {
  if (!scriptsEnabledForTurn(env)) {
    return [];
  }
  const storyRows = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.storyId, storyId), eq(scripts.enabled, 1)));
  let scenarioRows: ScriptRow[] = [];
  if (scenarioId) {
    scenarioRows = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.scenarioId, scenarioId), eq(scripts.enabled, 1)));
  }
  return orderScripts(
    scenarioRows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source,
      position: row.position,
    })),
    storyRows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source,
      position: row.position,
    })),
  );
}

// Runs one turn and maps the pipeline event stream onto SSE events:
// meta -> delta* -> done, or error. On client abort the pipeline keeps
// the input action and the stream simply ends.
// Same Hono inference reason as requireAuth; streamTurn receives route
// contexts.
export async function streamTurn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  c: any,
  deps: GenerationDeps,
  params: {
    storyId: string;
    story: StoryRow;
    actions: { id: string; idx: number; type: string; text: string; mode?: string | null }[];
    cards: { id: string; keys: string[]; entry: string; enabled: boolean }[];
    userInput?: string;
    // Continue turns skip the input action/hook (generateTurn).
    skipInput?: boolean;
    // Turn kind for the Layer 4 directive + input formatting.
    mode?: TurnMode;
    // Player input mode for the persisted input row; absent on
    // retry (the existing input row keeps its stored mode).
    inputMode?: string | null;
    provider: LLMProvider;
    signal: AbortSignal;
    reuseInputActionId?: string | null;
    scripts?: { id: string; name: string; source: string }[];
    scriptStates?: Map<string, unknown>;
    ranges?: { id: string; startIdx: number; endIdx: number; summary: string }[];
    restoreRangeIds?: string[];
    // Effective per-provider timeouts (null = pipeline defaults).
    ttftTimeoutMs?: number | null;
    totalTimeoutMs?: number | null;
  },
) {
  const { db } = deps;
  // Effective per-story generation settings, before the pipeline runs.
  const budget = storyBudget(params.story);
  const maxOutputTokens = params.story.maxOutputTokens ?? undefined;
  return streamSSE(c, async (stream) => {
    // Keepalive: a comment line every 15s while the turn streams, so
    // Cloudflare's idle timeout and intermediate proxies never kill
    // a slow generation. SSE clients ignore comment lines, so this
    // fires unconditionally — simpler than tracking the last event.
    const keepalive = setInterval(() => {
      void stream.write(": keepalive\n\n").catch(() => {
        // The client is gone; the turn loop fails on its next write
        // and this interval is cleared in the finally below.
      });
    }, KEEPALIVE_INTERVAL_MS);
    try {
      const gen = generateTurn({
        db,
        storyId: params.storyId,
        story: {
          aiInstructions: params.story.aiInstructions,
          plotEssentials: params.story.plotEssentials,
          memory: params.story.memory,
          summary: params.story.summary,
        },
        actions: params.actions,
        cards: params.cards,
        userInput: params.userInput,
        skipInput: params.skipInput,
        mode: params.mode,
        inputMode: params.inputMode,
        provider: params.provider,
        signal: params.signal,
        maxOutputTokens,
        budget,
        ttftTimeoutMs: params.ttftTimeoutMs ?? null,
        totalTimeoutMs: params.totalTimeoutMs ?? null,
        reuseInputActionId: params.reuseInputActionId,
        scripts: params.scripts,
        scriptStates: params.scriptStates,
        ranges: params.ranges,
        restoreRangeIds: params.restoreRangeIds,
      });
      // Compression runs only after a fully successful turn — never on
      // abort or error — and after `done`, off the visible path.
      let succeeded = false;
      try {
        let next = await gen.next();
        while (!next.done) {
          const event = next.value;
          if (event.type === "meta") {
            await stream.writeSSE({
              event: "meta",
              data: JSON.stringify({
                usage: event.usage,
                cardsInjected: event.cardsInjected,
                rangesApplied: event.rangesApplied,
                inputActionId: event.inputActionId,
              }),
            });
          } else {
            await stream.writeSSE({
              event: "delta",
              data: JSON.stringify({ text: event.text }),
            });
          }
          next = await gen.next();
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            outputActionId: next.value.outputActionId,
            usage: next.value.tokenUsage,
          }),
        });
        if (next.value.scriptErrors.length > 0) {
          await stream.writeSSE({
            event: "script_errors",
            data: JSON.stringify({
              errors: next.value.scriptErrors.map((e) => ({
                scriptId: e.scriptId,
                name: e.name,
                message: e.message,
              })),
            }),
          });
        }
        succeeded = true;
      } catch (err) {
        if (err instanceof AbortError || isAbortError(err, params.signal)) {
          return;
        }
        const code = err instanceof ProviderError ? err.code : "generation_failed";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code, message: providerErrorMessage(err) }),
        });
      }
      if (succeeded) {
        const requestId = c.get("requestId") as string | undefined;
        await maybeCompressAfterTurn(db, params.story, params.provider, params.signal, requestId);
      }
    } finally {
      clearInterval(keepalive);
    }
  });
}
