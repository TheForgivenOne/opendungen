// Pipeline hardening: retry-before-first-chunk, per-provider timeouts,
// and real-vs-estimated token usage.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actions } from "../db/schema";
import { generateTurn } from "./pipeline";
import { ProviderError, type LLMChunk, type LLMProvider } from "../llm/types";
import { createStoryRows, createTestApp } from "../testing";

const STORY_FIELDS = {
  aiInstructions: "Narrate.",
  plotEssentials: "",
  summary: "",
  memory: "",
};

function scriptedProvider(impl: {
  complete: (signal: AbortSignal) => AsyncIterable<LLMChunk>;
}): LLMProvider {
  return {
    kind: "ollama",
    supportsCaching: false,
    supportsMultipleSystemMessages: false,
    tokenMultiplier: 1.0,
    async *complete(_req, signal) {
      yield* impl.complete(signal);
    },
    async testConnection() {
      return { ok: true as const, model: "m" };
    },
    async listModels() {
      return { models: ["m"], source: "listing" as const };
    },
  };
}

describe("pipeline retry", () => {
  it("a 429 before the first chunk retries once and succeeds", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    let attempts = 0;
    const provider = scriptedProvider({
      async *complete() {
        attempts++;
        if (attempts === 1) {
          throw new ProviderError("rate_limit", "limited", 429);
        }
        yield { delta: "recovered", done: false };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
    });
    let done = await gen.next();
    while (!done.done) {
      done = await gen.next();
    }
    expect(done.value.outputActionId).toBeTruthy();
    expect(attempts).toBe(2);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows[1]).toMatchObject({ type: "output", text: "recovered" });
  });

  it("repeated 500s throw after the second attempt", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    let attempts = 0;
    const provider = scriptedProvider({
      async *complete() {
        attempts++;
        throw new ProviderError("unknown", "boom", 500);
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
    });
    await gen.next();
    await expect(gen.next()).rejects.toMatchObject({ code: "unknown" });
    expect(attempts).toBe(2);
    // The input is kept even on terminal failure.
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
  });

  it("never retries after the first chunk has been emitted", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    let attempts = 0;
    const provider = scriptedProvider({
      async *complete() {
        attempts++;
        yield { delta: "visible ", done: false };
        throw new ProviderError("unknown", "mid-stream reset", 500);
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
    });
    await gen.next(); // meta
    await gen.next(); // delta
    await expect(gen.next()).rejects.toMatchObject({ code: "unknown" });
    expect(attempts).toBe(1);
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "input" });
  });
});

describe("pipeline timeouts", () => {
  it("a stall past TTFT aborts with timeout_ttft and keeps the input", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = scriptedProvider({
      async *complete(signal) {
        // Stall forever (or until aborted).
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield { delta: "never", done: false };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hello?",
      provider,
      signal: new AbortController().signal,
      ttftTimeoutMs: 50,
      totalTimeoutMs: 5000,
    });
    await gen.next(); // meta
    await expect(gen.next()).rejects.toMatchObject({ code: "timeout_ttft" });
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idx: 0, type: "input", text: "hello?" });
  });

  it("a stream that never finishes aborts with timeout_total", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = scriptedProvider({
      async *complete(signal) {
        yield { delta: "starts ", done: false };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield { delta: "never", done: false };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "go on",
      provider,
      signal: new AbortController().signal,
      ttftTimeoutMs: 5000,
      totalTimeoutMs: 100,
    });
    await gen.next(); // meta
    await gen.next(); // delta
    await expect(gen.next()).rejects.toMatchObject({ code: "timeout_total" });
    const rows = await db.select().from(actions).where(eq(actions.storyId, storyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "input" });
  });

  it("null timeouts apply the defaults (a 100ms stall still succeeds)", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = scriptedProvider({
      async *complete() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield { delta: "slow but fine", done: false };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
      ttftTimeoutMs: null,
      totalTimeoutMs: null,
    });
    let done = await gen.next();
    while (!done.done) {
      done = await gen.next();
    }
    expect(done.value.outputActionId).toBeTruthy();
  });
});

describe("pipeline token usage", () => {
  it("records real provider usage when the final chunk carries it", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = scriptedProvider({
      async *complete() {
        yield { delta: "hello", done: false };
        yield { delta: "", done: true, usage: { inputTokens: 33, outputTokens: 7 } };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
    });
    let done = await gen.next();
    while (!done.done) {
      done = await gen.next();
    }
    expect(done.value.tokenUsage).toEqual({ inputTokens: 33, outputTokens: 7, source: "provider" });
  });

  it("falls back to the estimate when the provider omits usage", async () => {
    const { db } = createTestApp();
    const { storyId } = await createStoryRows(db);
    const provider = scriptedProvider({
      async *complete() {
        yield { delta: "hello world, this is output", done: false };
      },
    });
    const gen = generateTurn({
      db,
      storyId,
      story: STORY_FIELDS,
      actions: [],
      cards: [],
      userInput: "hi",
      provider,
      signal: new AbortController().signal,
    });
    let done = await gen.next();
    while (!done.done) {
      done = await gen.next();
    }
    expect(done.value.tokenUsage.source).toBe("estimated");
    expect(done.value.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(done.value.tokenUsage.outputTokens).toBeGreaterThan(0);
  });
});
