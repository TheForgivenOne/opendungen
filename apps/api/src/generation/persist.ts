// Turn persistence: input/output action writes plus the output
// hook. Streaming itself stays in pipeline.ts (generateTurn).
import { estimateTokens } from "../context/assemble";
import { appendAction, insertActionAtIdx, type ActionType } from "../action-log";
import type { AppDb } from "../app";
import { stories } from "../db/schema";
import { eq } from "drizzle-orm";
import { ProviderError, type LLMTokenUsage } from "../llm/types";
import { runOutputHook, saveScriptStates, type HookScript } from "./hooks";
import type { ScriptErrorInfo } from "../scripts/types";
import type { PipelineAction, TokenUsageResult } from "./pipeline";

export async function touchStory(db: AppDb, storyId: string): Promise<void> {
  await db.update(stories).set({ updatedAt: Date.now() }).where(eq(stories.id, storyId));
}

// The input action is persisted BEFORE the provider call begins, so a
// mid-stream error or abort leaves a lone input the user can retry —
// the client learns its id in the meta event. Continue turns persist
// no input at all (inputActionId stays null).
export async function persistInputAction(
  db: AppDb,
  storyId: string,
  actions: PipelineAction[],
  input: string,
  inputMode: string | null | undefined,
  skipInput: boolean | undefined,
  reuseInputActionId: string | null | undefined,
): Promise<{ inputActionId: string | null; inputIdx: number }> {
  let inputActionId: string | null = reuseInputActionId ?? null;
  let inputIdx = -1;
  if (skipInput) {
    inputActionId = null;
  } else if (inputActionId) {
    const existing = actions.find((a) => a.id === inputActionId);
    inputIdx = existing?.idx ?? -1;
    if (inputIdx < 0) {
      throw new ProviderError("unknown", "input action for retry was deleted");
    }
  } else {
    const row = await appendAction(db, storyId, "input", input, inputMode ?? null);
    inputActionId = row.id;
    inputIdx = row.idx;
  }
  return { inputActionId, inputIdx };
}

// Output hook runs only on success — never on abort — and AFTER the
// full output has streamed. The streamed text is already on the
// client as-is; the hook result is what gets persisted.
export async function persistOutputTurn(args: {
  db: AppDb;
  storyId: string;
  storyRef: { id: string };
  actions: PipelineAction[];
  output: string;
  scripts: HookScript[];
  states: Map<string, unknown>;
  skipInput: boolean | undefined;
  inputIdx: number;
  assembledUsageTotal: number;
  tokenMultiplier: number;
  realUsage: LLMTokenUsage | undefined;
}): Promise<{ outputActionId: string; tokenUsage: TokenUsageResult; errors: ScriptErrorInfo[] }> {
  const outputHook = await runOutputHook(
    args.storyRef,
    args.actions,
    args.output,
    args.scripts,
    args.states,
  );
  await saveScriptStates(args.db, args.storyId, outputHook.updatedStates);
  // Continue turns have no input row: the output appends at max+1.
  const outputRow = args.skipInput
    ? await appendAction(args.db, args.storyId, "output" as ActionType, outputHook.text)
    : await insertActionAtIdx(
        args.db,
        args.storyId,
        args.inputIdx + 1,
        "output" as ActionType,
        outputHook.text,
      );
  await touchStory(args.db, args.storyId);
  const tokenUsage: TokenUsageResult = args.realUsage
    ? { ...args.realUsage, source: "provider" }
    : {
        inputTokens: args.assembledUsageTotal,
        outputTokens: estimateTokens(args.output.length, args.tokenMultiplier),
        source: "estimated",
      };
  return { outputActionId: outputRow.id, tokenUsage, errors: outputHook.errors };
}
