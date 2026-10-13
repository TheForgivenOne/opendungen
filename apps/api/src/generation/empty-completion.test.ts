// Empty-completion handling: a turn whose stream carries zero output
// tokens retries the generation exactly once; two empties in a row
// surface `empty_completion` with the input persisted and no output.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actions } from "../db/schema";
import { generateTurn } from "./pipeline";
import { ProviderError, type LLMChunk, type LLMProvider, type LLMRequest } from "../llm/types";
import { createStoryRows, createTestApp } from "../testing";

const STORY_FIELDS = {
  aiInstructions: "Narrate.",
  plotEssentials: "",
  summary: "",
  memory: "",
};

// Serves one chunk script per complete() call (repeating the last).
function scriptedProvider(scripts: string[][]): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    async *complete(_req: LLMRequest, _signal: AbortSignal): AsyncIterable<LLMChunk> {
      const script = scripts[Math.min(calls, scripts.length - 1)];
      calls++;
      for (const delta of script) {
        yield { delta, done: false };
      }
    },
    async testConnection() {
      return { ok: true as const, model: "mock-model" };
    },
    async listModels() {
      return { models: ["mock-model"], source: "listing" as const };
    },
  };
  return { provider, calls: () => calls };
}

async function drain(gen: AsyncGenerator<unknown, unknown, void>): Promise<unknown[]> {
  const events: unknown[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

function turnArgs(
  db: ReturnType<typeof createTestApp>["db"],
  storyId: string,
  provider: LLMProvider,
) {
  return {
    db,
    storyId,
    story: STORY_FIELDS,
    actions: [],
    cards: [],
    userInput: "look around",
    provider,
    signal: new AbortController().signal,
  };
}

describe("empty completion", () => {
  it("retries once when the first attempt is empty, then persists the retry output", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { provider, calls } = scriptedProvider([[], ["Hello"]]);

    const gen = generateTurn(turnArgs(db, storyId, provider));
    const events = await drain(gen);
    expect(calls()).toBe(2);
    expect(events.filter((e) => (e as { type: string }).type === "delta")).toHaveLength(1);

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input" });
    expect(rows[1]).toMatchObject({ idx: 1, type: "output", text: "Hello" });
  });

  it("two empties throw empty_completion with input persisted and no output", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { provider, calls } = scriptedProvider([[]]);

    const gen = generateTurn(turnArgs(db, storyId, provider));
    await expect(drain(gen)).rejects.toMatchObject({ code: "empty_completion" });
    // Exactly one retry: two provider calls, never more.
    expect(calls()).toBe(2);

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "look around" });
  });

  it("treats whitespace-only output as empty", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { provider, calls } = scriptedProvider([["   \n "]]);

    const gen = generateTurn(turnArgs(db, storyId, provider));
    await expect(drain(gen)).rejects.toMatchObject({ code: "empty_completion" });
    expect(calls()).toBe(2);
  });

  it("does not retry when the first attempt has output", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { provider, calls } = scriptedProvider([["Hello"]]);

    const gen = generateTurn(turnArgs(db, storyId, provider));
    await drain(gen);
    expect(calls()).toBe(1);

    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ idx: 1, type: "output", text: "Hello" });
  });

  it("empty_completion carries the user-facing message", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const { provider } = scriptedProvider([[]]);

    const gen = generateTurn(turnArgs(db, storyId, provider));
    const err = await drain(gen).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("empty_completion");
    expect((err as ProviderError).message).toBe("The model returned no output. Try again.");
  });
});
